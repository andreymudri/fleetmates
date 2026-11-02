import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIM_CONDITIONS, buildSimEnv, runPlatformSim } from '../scripts/platform-sim.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const realpathProbe = path.join(here, 'fixtures', 'platform-sim', 'realpath-probe.mjs')
const eolProbe = path.join(here, 'fixtures', 'platform-sim', 'eol-probe.mjs')
const quiet = () => {}
const SCRATCH_PREFIX = 'fm-platform-sim-'
const scratchDirs = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith(SCRATCH_PREFIX)))

// An empty home and no GIT_CONFIG_GLOBAL, so the probes never read the user's own git config.
// The temp dir is canonicalised so the plain run is plain on hosts whose temp dir is already
// reached through a link (macOS /var -> /private/var).
async function isolatedEnv(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'fm-sim-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const realTmp = realpathSync(tmpdir())
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    TMPDIR: realTmp, TMP: realTmp, TEMP: realTmp,
  }
  delete env.GIT_CONFIG_GLOBAL
  return { home, env }
}

for (const [name, probe] of [['realpath', realpathProbe], ['eol', eolProbe]]) {
  test(`${name} probe exits 0 when spawned plainly`, async (t) => {
    const { env } = await isolatedEnv(t)
    const r = spawnSync(process.execPath, [probe], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  })

  // On Windows the symlink condition is skipped, so the realpath probe has nothing to catch.
  const skip = name === 'realpath' && process.platform === 'win32'
  test(`${name} probe exits non-zero under runPlatformSim`, { skip }, async (t) => {
    const { env } = await isolatedEnv(t)
    let out = ''
    const r = await runPlatformSim([process.execPath, probe], { baseEnv: env, onOutput: (c) => { out += c } })
    assert.notEqual(r.code, 0, out)
  })
}

test('SIM_CONDITIONS names the four conditions', () => {
  assert.deepEqual(SIM_CONDITIONS, ['symlinked-tmpdir', 'space-in-tmpdir', 'autocrlf', 'umask-077'])
})

test('buildSimEnv points TMPDIR, TMP and TEMP at one symlinked path containing a space', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const sim = await buildSimEnv({ baseEnv: env, platform: 'linux', homedir: home })
  t.after(() => sim.cleanup())
  const p = sim.env.TMPDIR
  assert.equal(sim.env.TMP, p)
  assert.equal(sim.env.TEMP, p)
  assert.ok(p.includes(' '), p)
  assert.ok(lstatSync(p).isSymbolicLink(), `${p} is not a symlink`)
  assert.deepEqual(sim.applied, SIM_CONDITIONS)
  assert.deepEqual(sim.skipped, [])
})

test('GIT_CONFIG_GLOBAL sets autocrlf and has no include when there was no previous global config', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const sim = await buildSimEnv({ baseEnv: env, platform: 'linux', homedir: home })
  t.after(() => sim.cleanup())
  const text = await readFile(sim.env.GIT_CONFIG_GLOBAL, 'utf8')
  assert.match(text, /autocrlf = true/)
  assert.doesNotMatch(text, /\[include\]/)
})

test('GIT_CONFIG_GLOBAL includes the previous ~/.gitconfig and git reads through it', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const prev = path.join(home, '.gitconfig')
  await writeFile(prev, '[user]\n\tname = Sim Probe\n')
  const sim = await buildSimEnv({ baseEnv: env, platform: 'linux', homedir: home })
  t.after(() => sim.cleanup())
  const text = await readFile(sim.env.GIT_CONFIG_GLOBAL, 'utf8')
  assert.match(text, /\[include\]/)
  assert.ok(text.includes(`path = ${JSON.stringify(prev)}`), text)
  const name = spawnSync('git', ['config', '--global', '--includes', 'user.name'], { env: sim.env, encoding: 'utf8' })
  assert.equal(name.stdout.trim(), 'Sim Probe')
  const crlf = spawnSync('git', ['config', '--global', 'core.autocrlf'], { env: sim.env, encoding: 'utf8' })
  assert.equal(crlf.stdout.trim(), 'true')
})

test('GIT_CONFIG_GLOBAL includes a previous GIT_CONFIG_GLOBAL from the base env', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const prev = path.join(home, 'custom global.cfg')
  await writeFile(prev, '[user]\n\temail = sim@example.invalid\n')
  const sim = await buildSimEnv({ baseEnv: { ...env, GIT_CONFIG_GLOBAL: prev }, platform: 'linux', homedir: home })
  t.after(() => sim.cleanup())
  const text = await readFile(sim.env.GIT_CONFIG_GLOBAL, 'utf8')
  assert.ok(text.includes(`path = ${JSON.stringify(prev)}`), text)
  assert.notEqual(sim.env.GIT_CONFIG_GLOBAL, prev)
})

test('the scratch directory is gone after a passing run', async (t) => {
  const { env } = await isolatedEnv(t)
  const before = scratchDirs()
  let out = ''
  const r = await runPlatformSim([process.execPath, '-e', 'console.log(process.env.TMPDIR)'], {
    baseEnv: env, onOutput: (c) => { out += c },
  })
  assert.equal(r.code, 0)
  const simTmp = out.trim()
  assert.ok(simTmp.length > 0)
  assert.equal(existsSync(simTmp), false, `${simTmp} still exists`)
  assert.deepEqual([...scratchDirs()].filter((n) => !before.has(n)), [])
})

test('the exit code is the command\'s own and the scratch directory is gone after a failure', async (t) => {
  const { env } = await isolatedEnv(t)
  const before = scratchDirs()
  const r = await runPlatformSim([process.execPath, '-e', 'process.exit(7)'], { baseEnv: env, onOutput: quiet })
  assert.equal(r.code, 7)
  assert.deepEqual([...scratchDirs()].filter((n) => !before.has(n)), [])
})

test('the scratch directory is gone after the spawn throws', async (t) => {
  const { env } = await isolatedEnv(t)
  const before = scratchDirs()
  const missing = path.join(tmpdir(), 'fm-sim-no-such-dir', 'nested')
  await assert.rejects(runPlatformSim([process.execPath, '-e', '0'], { cwd: missing, baseEnv: env, onOutput: quiet }))
  assert.deepEqual([...scratchDirs()].filter((n) => !before.has(n)), [])
})

test('output from stdout and stderr streams through onOutput', async (t) => {
  const { env } = await isolatedEnv(t)
  let out = ''
  await runPlatformSim([process.execPath, '-e', 'process.stdout.write("one\\n"); process.stderr.write("two\\n")'], {
    baseEnv: env, onOutput: (c) => { out += c },
  })
  assert.match(out, /one/)
  assert.match(out, /two/)
})

test('the child runs under umask 077 and the parent umask is unchanged', { skip: process.platform === 'win32' }, async (t) => {
  const { env } = await isolatedEnv(t)
  const parentBefore = process.umask()
  let out = ''
  await runPlatformSim([process.execPath, '-e', 'console.log(process.umask().toString(8))'], {
    baseEnv: env, onOutput: (c) => { out += c },
  })
  assert.equal(out.trim(), '77')
  assert.equal(process.umask(), parentBefore)
})

test('on win32 the symlink and umask conditions are reported as skipped', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const sim = await buildSimEnv({ baseEnv: env, platform: 'win32', homedir: home })
  t.after(() => sim.cleanup())
  const skippedNames = sim.skipped.map((s) => s.name)
  assert.ok(skippedNames.includes('symlinked-tmpdir'), JSON.stringify(sim.skipped))
  assert.ok(skippedNames.includes('umask-077'), JSON.stringify(sim.skipped))
  for (const s of sim.skipped) assert.ok(typeof s.reason === 'string' && s.reason.length > 0)
  assert.ok(sim.applied.includes('autocrlf'))
  assert.equal(sim.applied.includes('symlinked-tmpdir'), false)
  assert.equal(lstatSync(sim.env.TMPDIR).isSymbolicLink(), false)
  assert.equal(sim.env.TMP, sim.env.TMPDIR)
  assert.equal(sim.env.TEMP, sim.env.TMPDIR)
})

test('runPlatformSim with an injected win32 platform reports the skipped conditions', async (t) => {
  const { env } = await isolatedEnv(t)
  const r = await runPlatformSim([process.execPath, '-e', '0'], { baseEnv: env, platform: 'win32', onOutput: quiet })
  assert.equal(r.code, 0)
  assert.ok(r.skipped.some((s) => s.name === 'symlinked-tmpdir'))
  assert.ok(r.applied.includes('autocrlf'))
})

test('buildSimEnv cleanup removes the scratch directory', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const sim = await buildSimEnv({ baseEnv: env, platform: 'linux', homedir: home })
  const link = sim.env.TMPDIR
  await mkdir(path.join(link, 'child'))
  await sim.cleanup()
  assert.equal(existsSync(path.dirname(link)), false)
})
