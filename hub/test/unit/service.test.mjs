import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { afterEach } from 'node:test'
import { createServiceManager } from '../../server/setup/service.mjs'
import { LAUNCHD_LABELS, UNIT_NAMES, renderPlist, renderUnit } from '../../server/setup/units.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

// Placeholder target-platform paths. Only the systemd units directory is real, because writeUnit writes it itself;
// every other file effect goes to an in-memory store, so no test depends on the host's path module or file system.
const TARGETS = {
  linux: { home: '/home/you', state: '/home/you/.local/state/fleetmates/deck', hub: '/home/you/hub', node: '/usr/bin/node' },
  darwin: { home: '/Users/you', state: '/Users/you/.local/state/fleetmates/deck', hub: '/Users/you/hub', node: '/usr/local/bin/node' },
  win32: { home: 'C:\\Users\\you', state: 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck', hub: 'C:\\Users\\you\\hub', node: 'C:\\Program Files\\nodejs\\node.exe' }
}

/** Recording fakes for every injected effect. */
function harness({ platform, active = () => false, runCode = () => 0, uid = 501 } = {}) {
  const target = TARGETS[platform]
  const sep = platform === 'win32' ? '\\' : '/'
  const paths = {
    home: target.home,
    config: `${target.home}${sep}config`,
    state: target.state,
    logs: `${target.state}${sep}logs`,
    units: '/home/you/.config/systemd/user'
  }
  if (platform === 'linux') {
    paths.units = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'))
    roots.push(paths.units)
  }
  const files = new Map()
  const calls = []
  const spawns = []
  const writes = []
  const removed = []
  const probes = []
  const dirs = []
  const opens = []
  const closed = []
  let nextPid = 4242
  const manager = createServiceManager({
    platform, paths, uid,
    nodePath: target.node,
    hubPath: target.hub,
    env: { PATH: '/usr/bin' },
    run: async (file, args) => { calls.push([file, ...args]); const code = runCode(file, args); return { code, stdout: '', stderr: code ? 'failed' : '' } },
    spawn: (file, args, options) => {
      const child = { pid: nextPid++, unrefCalled: false, unref() { this.unrefCalled = true } }
      spawns.push({ file, args, options, child })
      return child
    },
    probe: async service => { probes.push(service); return active(service) },
    writeFile: async (file, content, options) => { writes.push({ file, content: String(content), mode: options?.mode }); files.set(file, String(content)) },
    mkdir: async (dir, options) => { dirs.push({ dir, mode: options?.mode }) },
    readFile: async file => {
      if (!files.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
      return files.get(file)
    },
    rm: async file => { removed.push(file); files.delete(file) },
    open: (file, flags, mode) => { opens.push({ file, flags, mode }); return 100 + opens.length - 1 },
    close: fd => { closed.push(fd) }
  })
  return { manager, paths, files, calls, spawns, writes, removed, probes, dirs, opens, closed, target }
}

test('systemd install writes both units and runs the same systemctl sequence init runs today', async () => {
  const { manager, paths, calls, target } = harness({ platform: 'linux' })
  assert.equal(manager.kind, 'systemd')
  await manager.install()
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'try-restart', 'fleetmates-deck.service'],
    ['systemctl', '--user', 'enable', '--now', ...UNIT_NAMES]
  ])
  for (const name of UNIT_NAMES) assert.equal(fs.readFileSync(path.join(paths.units, name), 'utf8'), renderUnit(name, target.node, target.hub))
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

const DECKD_PLIST = '/Users/you/Library/LaunchAgents/io.fleetmates.deck.deckd.plist'
const WEB_PLIST = '/Users/you/Library/LaunchAgents/io.fleetmates.deck.web.plist'

test('launchd install writes both plists with POSIX paths, then boots out and bootstraps each in gui/<uid>', async () => {
  const { manager, files, calls, writes } = harness({ platform: 'darwin', uid: 501, runCode: (file, args) => args[0] === 'bootout' ? 113 : 0 })
  assert.equal(manager.kind, 'launchd')
  await manager.install()
  assert.deepEqual(writes.map(w => [w.file, w.mode]), [[DECKD_PLIST, 0o644], [WEB_PLIST, 0o644]])
  const logs = '/Users/you/.local/state/fleetmates/deck/logs'
  assert.equal(files.get(DECKD_PLIST), renderPlist('io.fleetmates.deck.deckd', '/usr/local/bin/node', '/Users/you/hub/deckd/main.mjs', logs))
  assert.equal(files.get(WEB_PLIST), renderPlist('io.fleetmates.deck.web', '/usr/local/bin/node', '/Users/you/hub/server/main.mjs', logs))
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', 'gui/501/io.fleetmates.deck.deckd'],
    ['launchctl', 'bootstrap', 'gui/501', DECKD_PLIST],
    ['launchctl', 'bootout', 'gui/501/io.fleetmates.deck.web'],
    ['launchctl', 'bootstrap', 'gui/501', WEB_PLIST]
  ])
})

test('launchd install rejects when bootstrap fails', async () => {
  const { manager } = harness({ platform: 'darwin', uid: 501, runCode: (file, args) => args[0] === 'bootstrap' ? 5 : 0 })
  await assert.rejects(manager.install(), /launchctl bootstrap .*failed/)
})

test('launchd start, restart, stop use kickstart and kill, isActive trusts probe, uninstall removes the plists', async () => {
  const { manager, files, calls, probes, removed } = harness({ platform: 'darwin', uid: 501, active: service => service === 'web' })
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
  assert.equal(manager.describe('deckd'), 'logs: /Users/you/.local/state/fleetmates/deck/logs/deckd.out.log, /Users/you/.local/state/fleetmates/deck/logs/deckd.err.log')
  calls.length = 0
  await manager.uninstall()
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', 'gui/501/io.fleetmates.deck.deckd'],
    ['launchctl', 'bootout', 'gui/501/io.fleetmates.deck.web']
  ])
  assert.deepEqual(removed, [DECKD_PLIST, WEB_PLIST])
  assert.equal(files.has(DECKD_PLIST), false)
})

const WIN_STATE = 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck'

test('detached paths are Windows paths: backslash entry, log and pid files from a C:\\ hub path', async () => {
  const { manager, spawns, writes, opens } = harness({ platform: 'win32' })
  await manager.start('deckd')
  assert.deepEqual(spawns[0].args, ['C:\\Users\\you\\hub\\deckd\\main.mjs'])
  assert.equal(spawns[0].file, 'C:\\Program Files\\nodejs\\node.exe')
  assert.deepEqual(opens.map(o => o.file), [`${WIN_STATE}\\logs\\deckd.log`])
  assert.deepEqual(writes.map(w => w.file), [`${WIN_STATE}\\run\\deckd.pid`])
  assert.equal(manager.describe('web'), `logs: ${WIN_STATE}\\logs\\web.log`)
})

test('detached start spawns node hidden and detached with append-mode logs, unrefs, and writes the pid', async () => {
  const { manager, files, spawns, writes, opens, closed } = harness({ platform: 'win32' })
  assert.equal(manager.kind, 'detached')
  await manager.start('deckd')
  assert.equal(spawns.length, 1)
  const [{ args, options, child }] = spawns
  assert.deepEqual(args, ['C:\\Users\\you\\hub\\deckd\\main.mjs'])
  assert.equal(options.detached, true)
  assert.equal(options.windowsHide, true)
  assert.deepEqual(options.stdio, ['ignore', 100, 100])
  assert.deepEqual(opens, [{ file: `${WIN_STATE}\\logs\\deckd.log`, flags: 'a', mode: 0o600 }], 'the log is opened in append mode')
  assert.deepEqual(closed, [100], 'the parent closes its copy of the log fd')
  assert.equal(child.unrefCalled, true)
  const pidFile = `${WIN_STATE}\\run\\deckd.pid`
  assert.deepEqual(writes.map(w => [w.file, w.content, w.mode]), [[pidFile, '4242\n', 0o600]])
  await manager.restart('deckd')
  assert.equal(files.get(pidFile), '4243\n')
  await manager.start('web')
  assert.deepEqual(spawns[2].args, ['C:\\Users\\you\\hub\\server\\main.mjs'])
})

test('detached start of an active service is a no-op', async () => {
  const { manager, spawns, writes } = harness({ platform: 'win32', active: () => true })
  await manager.start('web')
  assert.equal(spawns.length, 0)
  assert.equal(writes.length, 0)
})

test('detached isActive trusts probe, not the pid file', async () => {
  const { manager, files, probes } = harness({ platform: 'win32', active: () => false })
  files.set(`${WIN_STATE}\\run\\deckd.pid`, '4242\n')
  assert.equal(await manager.isActive('deckd'), false)
  assert.deepEqual(probes, ['deckd'])
  const live = harness({ platform: 'win32', active: () => true })
  assert.equal(await live.manager.isActive('web'), true, 'no pid file, but the probe answers')
})

const WEB_PID = `${WIN_STATE}\\run\\web.pid`

test('detached stop of an active service runs taskkill on the recorded tree and removes the pid file', async () => {
  const { manager, files, calls, removed } = harness({ platform: 'win32', active: () => true })
  files.set(WEB_PID, '777\n')
  await manager.stop('web')
  assert.deepEqual(calls, [['taskkill', '/PID', '777', '/T', '/F']])
  assert.deepEqual(removed, [WEB_PID])
  assert.equal(files.has(WEB_PID), false)
  calls.length = 0
  await manager.stop('web')
  assert.deepEqual(calls, [], 'no pid file, nothing to kill')
})

test('detached stop with a leftover pid file and no answering probe kills nothing and removes the pid file', async () => {
  const { manager, files, calls, probes } = harness({ platform: 'win32', active: () => false })
  const pidFile = `${WIN_STATE}\\run\\deckd.pid`
  files.set(pidFile, '4242\n')
  await manager.stop('deckd')
  assert.deepEqual(probes, ['deckd'])
  assert.deepEqual(calls, [])
  assert.equal(files.has(pidFile), false)
})

test('detached stop never passes a corrupt pid to taskkill', async () => {
  for (const content of ['12abc\n', '0\n', '-1\n', '\n']) {
    const { manager, files, calls } = harness({ platform: 'win32', active: () => true })
    files.set(WEB_PID, content)
    await manager.stop('web')
    assert.deepEqual(calls, [], `pid file ${JSON.stringify(content)}`)
    assert.equal(files.has(WEB_PID), false)
  }
})

test('detached stop throws and keeps the pid file when taskkill fails while the probe still answers', async () => {
  const { manager, files } = harness({ platform: 'win32', active: () => true, runCode: () => 1 })
  files.set(WEB_PID, '777\n')
  await assert.rejects(manager.stop('web'), /taskkill \/PID 777 failed/)
  assert.equal(files.has(WEB_PID), true)
  let alive = true
  const gone = harness({ platform: 'win32', active: () => { const was = alive; alive = false; return was }, runCode: () => 128 })
  gone.files.set(WEB_PID, '777\n')
  await gone.manager.stop('web')
  assert.equal(gone.files.has(WEB_PID), false, 'taskkill failed but the service is down, so stop succeeds')
})

test('detached install adds the HKCU Run value and starts both services; uninstall deletes it and stops both', async () => {
  let running = false
  const { manager, files, calls, spawns } = harness({ platform: 'win32', active: () => running })
  await manager.install()
  const command = 'conhost.exe --headless "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\you\\hub\\bin\\fleetmates-deck.mjs" start'
  assert.deepEqual(calls, [['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'fleetmates-deck', '/t', 'REG_SZ', '/d', command, '/f']])
  assert.deepEqual(spawns.map(s => s.args[0]), ['C:\\Users\\you\\hub\\deckd\\main.mjs', 'C:\\Users\\you\\hub\\server\\main.mjs'])
  calls.length = 0
  running = true
  await manager.uninstall()
  assert.deepEqual(calls, [
    ['reg', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'fleetmates-deck', '/f'],
    ['taskkill', '/PID', '4242', '/T', '/F'],
    ['taskkill', '/PID', '4243', '/T', '/F']
  ])
  assert.equal(files.has(`${WIN_STATE}\\run\\deckd.pid`), false)
})
