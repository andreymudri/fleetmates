import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServiceManager } from '../../server/setup/service.mjs'
import { LAUNCHD_LABELS, UNIT_NAMES, renderPlist, renderUnit } from '../../server/setup/units.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

/** A temp home with the paths setupPaths returns, and recording fakes for every injected effect. */
function harness({ platform, active = () => false, runCode = () => 0, uid = 501 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'))
  roots.push(home)
  const paths = {
    home,
    config: path.join(home, '.config/fleetmates/deck'),
    state: path.join(home, '.local/state/fleetmates/deck'),
    logs: path.join(home, '.local/state/fleetmates/deck/logs'),
    units: path.join(home, '.config/systemd/user')
  }
  const calls = []
  const spawns = []
  const writes = []
  const removed = []
  const probes = []
  let nextPid = 4242
  const manager = createServiceManager({
    platform, paths, uid,
    nodePath: '/usr/bin/node',
    hubPath: hub,
    env: { PATH: '/usr/bin' },
    run: async (file, args) => { calls.push([file, ...args]); const code = runCode(file, args); return { code, stdout: '', stderr: code ? 'failed' : '' } },
    spawn: (file, args, options) => {
      const child = { pid: nextPid++, unrefCalled: false, unref() { this.unrefCalled = true } }
      spawns.push({ file, args, options, child })
      return child
    },
    probe: async service => { probes.push(service); return active(service) },
    writeFile: async (file, content, options) => { writes.push({ file, content: String(content), mode: options?.mode }); await fs.promises.writeFile(file, content, options) },
    mkdir: (dir, options) => fs.promises.mkdir(dir, options),
    readFile: (file, encoding) => fs.promises.readFile(file, encoding),
    rm: async (file, options) => { removed.push(file); await fs.promises.rm(file, options) }
  })
  return { manager, paths, calls, spawns, writes, removed, probes, home }
}

test('systemd install writes both units and runs the same systemctl sequence init runs today', async () => {
  const { manager, paths, calls } = harness({ platform: 'linux' })
  assert.equal(manager.kind, 'systemd')
  await manager.install()
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'try-restart', 'fleetmates-deck.service'],
    ['systemctl', '--user', 'enable', '--now', ...UNIT_NAMES]
  ])
  for (const name of UNIT_NAMES) assert.equal(fs.readFileSync(path.join(paths.units, name), 'utf8'), renderUnit(name, '/usr/bin/node', hub))
  calls.length = 0
  await manager.install()
  assert.deepEqual(calls, [['systemctl', '--user', 'enable', '--now', ...UNIT_NAMES]], 'unchanged units skip daemon-reload and try-restart')
})

test('systemd start, stop, restart, isActive and describe name the unit', async () => {
  let code = 0
  const { manager, calls } = harness({ platform: 'linux', runCode: () => code })
  await manager.start('deckd')
  await manager.stop('web')
  await manager.restart('deckd')
  assert.equal(await manager.isActive('deckd'), true)
  code = 3
  assert.equal(await manager.isActive('web'), false)
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'start', 'fleetmates-deckd.service'],
    ['systemctl', '--user', 'stop', 'fleetmates-deck.service'],
    ['systemctl', '--user', 'restart', 'fleetmates-deckd.service'],
    ['systemctl', '--user', 'is-active', '--quiet', 'fleetmates-deckd.service'],
    ['systemctl', '--user', 'is-active', '--quiet', 'fleetmates-deck.service']
  ])
  assert.equal(manager.describe('web'), 'journalctl --user -u fleetmates-deck.service')
  await assert.rejects(manager.start('other'), /unknown service/)
})

test('systemd install fails when systemctl fails', async () => {
  const { manager } = harness({ platform: 'linux', runCode: (file, args) => args.includes('enable') ? 1 : 0 })
  await assert.rejects(manager.install(), /systemctl .*failed/)
})

test('renderPlist escapes XML and sets Umask 63, KeepAlive on failure and the log paths', () => {
  assert.deepEqual(LAUNCHD_LABELS, { deckd: 'io.fleetmates.deck.deckd', web: 'io.fleetmates.deck.web' })
  const xml = renderPlist('io.fleetmates.deck.deckd', '/Users/you/n&<de/bin/node', '/Users/you/hub/deckd/main.mjs', '/Users/you/logs')
  assert.equal(xml, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.fleetmates.deck.deckd</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/n&amp;&lt;de/bin/node</string>
    <string>/Users/you/hub/deckd/main.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>/Users/you/logs/deckd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/logs/deckd.err.log</string>
</dict>
</plist>
`)
  assert.throws(() => renderPlist('io.fleetmates.deck.deckd', 'node', '/x', '/l'), /absolute/)
})

test('launchd install writes both plists, then boots out and bootstraps each in gui/<uid>', async () => {
  const { manager, paths, calls, writes } = harness({ platform: 'darwin', uid: 501, runCode: (file, args) => args[0] === 'bootout' ? 113 : 0 })
  assert.equal(manager.kind, 'launchd')
  await manager.install()
  const agents = path.join(paths.home, 'Library/LaunchAgents')
  const deckdPlist = path.join(agents, 'io.fleetmates.deck.deckd.plist')
  const webPlist = path.join(agents, 'io.fleetmates.deck.web.plist')
  assert.deepEqual(writes.map(w => [w.file, w.mode]), [[deckdPlist, 0o644], [webPlist, 0o644]])
  assert.equal(fs.readFileSync(deckdPlist, 'utf8'), renderPlist('io.fleetmates.deck.deckd', '/usr/bin/node', path.join(hub, 'deckd/main.mjs'), paths.logs))
  assert.equal(fs.readFileSync(webPlist, 'utf8'), renderPlist('io.fleetmates.deck.web', '/usr/bin/node', path.join(hub, 'server/main.mjs'), paths.logs))
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', 'gui/501/io.fleetmates.deck.deckd'],
    ['launchctl', 'bootstrap', 'gui/501', deckdPlist],
    ['launchctl', 'bootout', 'gui/501/io.fleetmates.deck.web'],
    ['launchctl', 'bootstrap', 'gui/501', webPlist]
  ])
})

test('launchd install rejects when bootstrap fails', async () => {
  const { manager } = harness({ platform: 'darwin', uid: 501, runCode: (file, args) => args[0] === 'bootstrap' ? 5 : 0 })
  await assert.rejects(manager.install(), /launchctl bootstrap .*failed/)
})

test('launchd start, restart, stop use kickstart and kill, isActive trusts probe, uninstall removes the plists', async () => {
  const { manager, paths, calls, probes, removed } = harness({ platform: 'darwin', uid: 501, active: service => service === 'web' })
  await manager.install()
  calls.length = 0
  await manager.start('deckd')
  await manager.restart('web')
  await manager.stop('deckd')
  assert.equal(await manager.isActive('web'), true)
  assert.equal(await manager.isActive('deckd'), false)
  assert.deepEqual(probes, ['web', 'deckd'])
  assert.deepEqual(calls, [
    ['launchctl', 'kickstart', 'gui/501/io.fleetmates.deck.deckd'],
    ['launchctl', 'kickstart', '-k', 'gui/501/io.fleetmates.deck.web'],
    ['launchctl', 'kill', 'SIGTERM', 'gui/501/io.fleetmates.deck.deckd']
  ])
  assert.match(manager.describe('deckd'), new RegExp(path.join(paths.logs, 'deckd.out.log').replaceAll('.', '\\.')))
  calls.length = 0
  await manager.uninstall()
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', 'gui/501/io.fleetmates.deck.deckd'],
    ['launchctl', 'bootout', 'gui/501/io.fleetmates.deck.web']
  ])
  const agents = path.join(paths.home, 'Library/LaunchAgents')
  assert.deepEqual(removed, [path.join(agents, 'io.fleetmates.deck.deckd.plist'), path.join(agents, 'io.fleetmates.deck.web.plist')])
  assert.equal(fs.existsSync(path.join(agents, 'io.fleetmates.deck.deckd.plist')), false)
})

test('detached start spawns node hidden and detached with append-mode logs, unrefs, and writes the pid', async () => {
  const { manager, paths, spawns, writes } = harness({ platform: 'win32' })
  assert.equal(manager.kind, 'detached')
  await manager.start('deckd')
  assert.equal(spawns.length, 1)
  const [{ file, args, options, child }] = spawns
  assert.equal(file, '/usr/bin/node')
  assert.deepEqual(args, [path.join(hub, 'deckd/main.mjs')])
  assert.equal(options.detached, true)
  assert.equal(options.windowsHide, true)
  assert.equal(options.stdio[0], 'ignore')
  assert.equal(typeof options.stdio[1], 'number')
  assert.equal(typeof options.stdio[2], 'number')
  assert.equal(child.unrefCalled, true)
  const pidFile = path.join(paths.state, 'run/deckd.pid')
  assert.deepEqual(writes.filter(w => w.file === pidFile).map(w => [w.content, w.mode]), [['4242\n', 0o600]])
  assert.equal(fs.readFileSync(pidFile, 'utf8'), '4242\n')
  assert.ok(fs.existsSync(path.join(paths.logs, 'deckd.log')), 'the log file is opened under logs')
  fs.writeFileSync(path.join(paths.logs, 'deckd.log'), 'before\n')
  await manager.restart('deckd')
  assert.equal(fs.readFileSync(path.join(paths.logs, 'deckd.log'), 'utf8'), 'before\n', 'reopening the log never truncates it')
  assert.equal(fs.readFileSync(pidFile, 'utf8'), '4243\n')
  await manager.start('web')
  assert.deepEqual(spawns[2].args, [path.join(hub, 'server/main.mjs')])
  assert.equal(manager.describe('web'), `logs: ${path.join(paths.logs, 'web.log')}`)
})

test('detached start of an active service is a no-op', async () => {
  const { manager, spawns, writes } = harness({ platform: 'win32', active: () => true })
  await manager.start('web')
  assert.equal(spawns.length, 0)
  assert.equal(writes.length, 0)
})

test('detached isActive trusts probe, not the pid file', async () => {
  const { manager, paths, probes } = harness({ platform: 'win32', active: () => false })
  fs.mkdirSync(path.join(paths.state, 'run'), { recursive: true })
  fs.writeFileSync(path.join(paths.state, 'run/deckd.pid'), `${process.pid}\n`)
  assert.equal(await manager.isActive('deckd'), false)
  assert.deepEqual(probes, ['deckd'])
  const live = harness({ platform: 'win32', active: () => true })
  assert.equal(await live.manager.isActive('web'), true, 'no pid file, but the probe answers')
})

function writePid(paths, service, content) {
  const file = path.join(paths.state, `run/${service}.pid`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

test('detached stop of an active service runs taskkill on the recorded tree and removes the pid file', async () => {
  const { manager, paths, calls, removed } = harness({ platform: 'win32', active: () => true })
  const pidFile = writePid(paths, 'web', '777\n')
  await manager.stop('web')
  assert.deepEqual(calls, [['taskkill', '/PID', '777', '/T', '/F']])
  assert.deepEqual(removed, [pidFile])
  assert.equal(fs.existsSync(pidFile), false)
  calls.length = 0
  await manager.stop('web')
  assert.deepEqual(calls, [], 'no pid file, nothing to kill')
})

test('detached stop with a leftover pid file and no answering probe kills nothing and removes the pid file', async () => {
  const { manager, paths, calls, probes } = harness({ platform: 'win32', active: () => false })
  const pidFile = writePid(paths, 'deckd', '4242\n')
  await manager.stop('deckd')
  assert.deepEqual(probes, ['deckd'])
  assert.deepEqual(calls, [])
  assert.equal(fs.existsSync(pidFile), false)
})

test('detached stop never passes a corrupt pid to taskkill', async () => {
  for (const content of ['12abc\n', '0\n', '-1\n', '\n']) {
    const { manager, paths, calls } = harness({ platform: 'win32', active: () => true })
    const pidFile = writePid(paths, 'web', content)
    await manager.stop('web')
    assert.deepEqual(calls, [], `pid file ${JSON.stringify(content)}`)
    assert.equal(fs.existsSync(pidFile), false)
  }
})

test('detached stop throws and keeps the pid file when taskkill fails while the probe still answers', async () => {
  const { manager, paths } = harness({ platform: 'win32', active: () => true, runCode: () => 1 })
  const pidFile = writePid(paths, 'web', '777\n')
  await assert.rejects(manager.stop('web'), /taskkill \/PID 777 failed/)
  assert.equal(fs.existsSync(pidFile), true)
  let alive = true
  const gone = harness({ platform: 'win32', active: () => { const was = alive; alive = false; return was }, runCode: () => 128 })
  const gonePid = writePid(gone.paths, 'web', '777\n')
  await gone.manager.stop('web')
  assert.equal(fs.existsSync(gonePid), false, 'taskkill failed but the service is down, so stop succeeds')
})

test('detached install adds the HKCU Run value and starts both services; uninstall deletes it and stops both', async () => {
  let running = false
  const { manager, paths, calls, spawns } = harness({ platform: 'win32', active: () => running })
  await manager.install()
  const command = `conhost.exe --headless "/usr/bin/node" "${path.join(hub, 'bin/fleetmates-deck.mjs')}" start`
  assert.deepEqual(calls, [['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'fleetmates-deck', '/t', 'REG_SZ', '/d', command, '/f']])
  assert.deepEqual(spawns.map(s => s.args[0]), [path.join(hub, 'deckd/main.mjs'), path.join(hub, 'server/main.mjs')])
  calls.length = 0
  running = true
  await manager.uninstall()
  assert.deepEqual(calls, [
    ['reg', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'fleetmates-deck', '/f'],
    ['taskkill', '/PID', '4242', '/T', '/F'],
    ['taskkill', '/PID', '4243', '/T', '/F']
  ])
  assert.equal(fs.existsSync(path.join(paths.state, 'run/deckd.pid')), false)
})
