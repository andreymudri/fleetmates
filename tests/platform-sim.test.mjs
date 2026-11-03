import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIM_CONDITIONS, buildSimEnv, runPlatformSim, defaultSystemOrigins } from '../scripts/platform-sim.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const realpathProbe = path.join(here, 'fixtures', 'platform-sim', 'realpath-probe.mjs')
const eolProbe = path.join(here, 'fixtures', 'platform-sim', 'eol-probe.mjs')
const quiet = () => {}
const SCRATCH_PREFIX = 'fm-platform-sim-'
const scratchDirs = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith(SCRATCH_PREFIX)))

// An empty home, no GIT_CONFIG_GLOBAL or GIT_CONFIG_SYSTEM and GIT_CONFIG_NOSYSTEM=1, so the probes never read the
// user's or the host's git config (Git for Windows sets core.autocrlf=true system-wide). The temp dir is canonicalised so the plain run is plain on hosts whose temp dir is already
// reached through a link (macOS /var -> /private/var).
async function isolatedEnv(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'fm-sim-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const realTmp = realpathSync(tmpdir())
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    TMPDIR: realTmp, TMP: realTmp, TEMP: realTmp, GIT_CONFIG_NOSYSTEM: '1',
  }
  delete env.GIT_CONFIG_GLOBAL
  // The suite may itself run under the simulator (ci-local, a platformSim gate check), which sets
  // GIT_CONFIG_SYSTEM; the probes here must not inherit it.
  delete env.GIT_CONFIG_SYSTEM
  return { home, env }
}

for (const [name, probe] of [['realpath', realpathProbe], ['eol', eolProbe]]) {
  test(`${name} probe exits 0 when spawned plainly`, async (t) => {
    const { env } = await isolatedEnv(t)
    const r = spawnSync(process.execPath, [probe], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  })

  // Git for Windows ships a system config with core.autocrlf=true; the plain run must not see it.
  test(`${name} probe exits 0 plainly on a host whose system git config sets autocrlf`, async (t) => {
    const { home, env } = await isolatedEnv(t)
    const system = path.join(home, 'system-gitconfig')
    await writeFile(system, '[core]\n\tautocrlf = true\n')
    const r = spawnSync(process.execPath, [probe], { env: { ...env, GIT_CONFIG_SYSTEM: system }, encoding: 'utf8' })
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

test('GIT_CONFIG_SYSTEM sets autocrlf and includes nothing when the system config was turned off', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const sim = await buildSimEnv({ baseEnv: env, platform: 'linux', homedir: home, readSystemOrigins: () => { throw new Error('not consulted') } })
  t.after(() => sim.cleanup())
  const text = await readFile(sim.env.GIT_CONFIG_SYSTEM, 'utf8')
  assert.match(text, /autocrlf = true/)
  assert.doesNotMatch(text, /\[include\]/)
  assert.equal(sim.env.GIT_CONFIG_NOSYSTEM, undefined, 'git must read the simulated system file')
  const crlf = spawnSync('git', ['config', 'core.autocrlf'], { env: sim.env, encoding: 'utf8' })
  assert.equal(crlf.stdout.trim(), 'true')
})

test('GIT_CONFIG_SYSTEM includes a previous GIT_CONFIG_SYSTEM and git reads through it', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const prev = path.join(home, 'system git.cfg')
  await writeFile(prev, '[user]\n\tname = System Probe\n')
  const baseEnv = { ...env, GIT_CONFIG_SYSTEM: prev }
  delete baseEnv.GIT_CONFIG_NOSYSTEM
  const sim = await buildSimEnv({ baseEnv, platform: 'linux', homedir: home })
  t.after(() => sim.cleanup())
  assert.notEqual(sim.env.GIT_CONFIG_SYSTEM, prev)
  const text = await readFile(sim.env.GIT_CONFIG_SYSTEM, 'utf8')
  assert.ok(text.includes(`path = ${JSON.stringify(prev)}`), text)
  const name = spawnSync('git', ['config', '--system', '--includes', 'user.name'], { env: sim.env, encoding: 'utf8' })
  assert.equal(name.stdout.trim(), 'System Probe')
})

test('GIT_CONFIG_SYSTEM includes the system config git reads by default', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const etc = path.join(home, 'etc-gitconfig')
  await writeFile(etc, '[user]\n\temail = etc@example.invalid\n')
  const baseEnv = { ...env }
  delete baseEnv.GIT_CONFIG_NOSYSTEM
  const sim = await buildSimEnv({ baseEnv, platform: 'linux', homedir: home, readSystemOrigins: () => [etc, path.join(home, 'missing')] })
  t.after(() => sim.cleanup())
  const text = await readFile(sim.env.GIT_CONFIG_SYSTEM, 'utf8')
  assert.ok(text.includes(`path = ${JSON.stringify(etc)}`), text)
  assert.ok(!text.includes('missing'), 'a file that does not exist is not included')
})

test('the global config is left alone: a fake HOME .gitconfig is still read, beside the simulated autocrlf', async (t) => {
  const { home, env } = await isolatedEnv(t)
  await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Home Probe\n')
  const sim = await buildSimEnv({ baseEnv: env, platform: 'linux', homedir: home })
  t.after(() => sim.cleanup())
  assert.equal(sim.env.GIT_CONFIG_GLOBAL, undefined)
  const name = spawnSync('git', ['config', 'user.name'], { env: sim.env, encoding: 'utf8' })
  assert.equal(name.stdout.trim(), 'Home Probe')
  const crlf = spawnSync('git', ['config', 'core.autocrlf'], { env: sim.env, encoding: 'utf8' })
  assert.equal(crlf.stdout.trim(), 'true')
})

test('defaultSystemOrigins names the system files git reads, and none when it reads none', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const sys = path.join(home, 'sys.cfg')
  await writeFile(sys, '[core]\n\tpager = cat\n')
  const baseEnv = { ...env, GIT_CONFIG_SYSTEM: sys }
  delete baseEnv.GIT_CONFIG_NOSYSTEM
  assert.deepEqual(defaultSystemOrigins(baseEnv), [sys])
  // A runner may ship a real system config, so the empty case names a file that does not exist.
  assert.deepEqual(defaultSystemOrigins({ ...baseEnv, GIT_CONFIG_SYSTEM: path.join(home, 'none.cfg') }), [])
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
  // Pin the parent at 022 so the assertion does not depend on the host's own umask.
  const hostUmask = process.umask(0o022)
  t.after(() => process.umask(hostUmask))
  let out = ''
  await runPlatformSim([process.execPath, '-e', 'console.log(process.umask().toString(8))'], {
    baseEnv: env, onOutput: (c) => { out += c },
  })
  assert.equal(out.trim(), '77')
  assert.equal(process.umask(), 0o022)
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

const posixOnly = { skip: process.platform === 'win32' }

test('a read-only directory left under TMPDIR is still removed and the exit code is kept', posixOnly, async (t) => {
  const { env } = await isolatedEnv(t)
  const before = scratchDirs()
  const script = [
    'const fs = require("node:fs"), path = require("node:path")',
    'const ro = path.join(process.env.TMPDIR, "ro", "inner")',
    'fs.mkdirSync(ro, { recursive: true })',
    'fs.writeFileSync(path.join(ro, "f"), "x")',
    'fs.chmodSync(ro, 0o555)',
    'fs.chmodSync(path.dirname(ro), 0o500)',
    'process.exit(3)',
  ].join('\n')
  let out = ''
  const r = await runPlatformSim([process.execPath, '-e', script], { baseEnv: env, onOutput: (c) => { out += c } })
  assert.equal(r.code, 3, out)
  assert.deepEqual([...scratchDirs()].filter((n) => !before.has(n)), [])
})

const failingCleanup = async (opts) => {
  const sim = await buildSimEnv(opts)
  return { ...sim, cleanup: async () => { await sim.cleanup(); throw new Error('injected cleanup failure') } }
}

test('a cleanup failure is reported on onOutput and never replaces the exit code', async (t) => {
  const { env } = await isolatedEnv(t)
  let out = ''
  const r = await runPlatformSim([process.execPath, '-e', 'process.exit(5)'], {
    baseEnv: env, buildEnv: failingCleanup, onOutput: (c) => { out += c },
  })
  assert.equal(r.code, 5)
  assert.match(out, /injected cleanup failure/)
})

test('a cleanup failure after a spawn error still rejects with the spawn error', async (t) => {
  const { env } = await isolatedEnv(t)
  const missing = path.join(tmpdir(), 'fm-sim-no-such-dir', 'nested')
  await assert.rejects(
    runPlatformSim([process.execPath, '-e', '0'], { cwd: missing, baseEnv: env, buildEnv: failingCleanup, onOutput: quiet }),
    (err) => err.code === 'ENOENT',
  )
})

test('buildSimEnv removes its scratch directory when it fails after creating it', async (t) => {
  const { home, env } = await isolatedEnv(t)
  const before = scratchDirs()
  // The system config is read only after the scratch directory exists.
  const baseEnv = { ...env }
  delete baseEnv.GIT_CONFIG_NOSYSTEM
  Object.defineProperty(baseEnv, 'GIT_CONFIG_NOSYSTEM', { enumerable: true, get() { throw new Error('injected env failure') } })
  await assert.rejects(buildSimEnv({ baseEnv, platform: 'linux', homedir: home }), /injected env failure/)
  assert.deepEqual([...scratchDirs()].filter((n) => !before.has(n)), [])
})

test('a child killed by SIGTERM yields exit code 143', posixOnly, async (t) => {
  const { env } = await isolatedEnv(t)
  const r = await runPlatformSim([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], { baseEnv: env, onOutput: quiet })
  assert.equal(r.code, 143)
})

test('cleanup never follows a symlink out of the scratch directory', posixOnly, async (t) => {
  const { env } = await isolatedEnv(t)
  const outside = await mkdtemp(path.join(tmpdir(), 'fm-sim-outside-'))
  const ro = path.join(outside, 'ro')
  await mkdir(ro)
  await writeFile(path.join(ro, 'keep'), 'x')
  await chmod(ro, 0o555)
  t.after(async () => { await chmod(ro, 0o755); await rm(outside, { recursive: true, force: true }) })
  const script = 'require("node:fs").symlinkSync(process.argv[1], require("node:path").join(process.env.TMPDIR, "out"), "dir")'
  let out = ''
  const r = await runPlatformSim([process.execPath, '-e', script, ro], { baseEnv: env, onOutput: (c) => { out += c } })
  assert.equal(r.code, 0, out)
  assert.equal(statSync(ro).mode & 0o777, 0o555)
  assert.equal(existsSync(path.join(ro, 'keep')), true)
})

test('a failed symlink skips that condition and still runs the command', async (t) => {
  const { env } = await isolatedEnv(t)
  const symlinkImpl = async () => { throw Object.assign(new Error('injected symlink failure'), { code: 'EPERM' }) }
  const buildEnv = (opts) => buildSimEnv({ ...opts, symlinkImpl })
  const before = scratchDirs()
  let out = ''
  const r = await runPlatformSim([process.execPath, '-e', 'console.log(process.env.TMPDIR); process.exit(4)'], {
    baseEnv: env, platform: 'linux', buildEnv, onOutput: (c) => { out += c },
  })
  assert.equal(r.code, 4)
  const simTmp = out.trim()
  assert.ok(simTmp.includes(' '), simTmp)
  assert.equal(r.applied.includes('symlinked-tmpdir'), false)
  assert.ok(r.applied.includes('space-in-tmpdir'))
  const skip = r.skipped.find((s) => s.name === 'symlinked-tmpdir')
  assert.ok(skip, JSON.stringify(r.skipped))
  assert.match(skip.reason, /EPERM/)
  assert.deepEqual([...scratchDirs()].filter((n) => !before.has(n)), [])
})
