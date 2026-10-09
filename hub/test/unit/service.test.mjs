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
function harness({ platform, active = () => false, runCode = () => 0, runOut = () => '', uid = 501 } = {}) {
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
    run: async (file, args) => { calls.push([file, ...args]); const code = runCode(file, args); return { code, stdout: runOut(file, args), stderr: code ? 'failed' : '' } },
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
const DECKD_PID = `${WIN_STATE}\\run\\deckd.pid`
const WEB_LINE = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\you\\hub\\server\\main.mjs"\r\n'
const DECKD_LINE = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\you\\hub\\deckd\\main.mjs"\r\n'

/** The command line query stop runs for `pid`. */
const PS = pid => ['powershell', '-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]
const TASKKILL = pid => ['taskkill', '/PID', String(pid), '/T', '/F']

/**
 * A `runOut` answering the command line query from `lines` (pid -> command line, or a function of the
 * number of queries so far) and nothing else.
 */
function commandLines (lines) {
  let asked = 0
  return (file, args) => {
    if (file !== 'powershell') return ''
    const pid = args[2].match(/ProcessId=(\d+)/)?.[1]
    const line = lines[pid]
    return typeof line === 'function' ? line(asked++) : line ?? ''
  }
}

test('detached stop kills a pid whose command line runs the service entry, then removes the pid file', async () => {
  const { manager, files, calls, removed } = harness({ platform: 'win32', runOut: commandLines({ 777: WEB_LINE }) })
  files.set(WEB_PID, '777\n')
  await manager.stop('web')
  assert.deepEqual(calls, [PS(777), TASKKILL(777)])
  assert.deepEqual(removed, [WEB_PID])
  assert.equal(files.has(WEB_PID), false)
  calls.length = 0
  await manager.stop('web')
  assert.deepEqual(calls, [], 'no pid file, nothing to kill')
})

test('detached stop matches the entry path case-insensitively with either separator', async () => {
  for (const line of ['node C:/USERS/YOU/hub/server/MAIN.mjs', 'node.exe c:\\users\\you\\HUB\\server\\main.mjs --flag', '"node" "C:/Users/you/hub\\server/main.mjs"']) {
    const { manager, files, calls } = harness({ platform: 'win32', runOut: commandLines({ 777: line }) })
    files.set(WEB_PID, '777\n')
    await manager.stop('web')
    assert.deepEqual(calls, [PS(777), TASKKILL(777)], line)
  }
})

test('detached stop does not kill a pid whose command line is not this service, even when the probe answers', async () => {
  const others = [
    '"C:\\Windows\\notepad.exe" C:\\Users\\you\\notes.txt',
    DECKD_LINE,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\you\\hub\\server\\main.mjs.bak"',
    '"C:\\Program Files\\nodejs\\node.exe" "D:\\other\\hub\\server\\main.mjs"',
    ''
  ]
  for (const line of others) {
    const { manager, files, calls } = harness({ platform: 'win32', active: () => true, runOut: commandLines({ 777: line }) })
    files.set(WEB_PID, '777\n')
    await manager.stop('web')
    assert.deepEqual(calls, [PS(777)], JSON.stringify(line))
    assert.equal(files.has(WEB_PID), false, 'the stale pid file is dropped')
  }
})

test('detached stop of a hung service whose probe is silent still kills it by its command line', async () => {
  const { manager, files, calls } = harness({ platform: 'win32', active: () => false, runOut: commandLines({ 4242: DECKD_LINE }) })
  files.set(DECKD_PID, '4242\n')
  await manager.stop('deckd')
  assert.deepEqual(calls, [PS(4242), TASKKILL(4242)])
  assert.equal(files.has(DECKD_PID), false)
})

test('detached stop kills nothing when the command line query fails', async () => {
  const { manager, files, calls } = harness({ platform: 'win32', active: () => true, runCode: file => file === 'powershell' ? 1 : 0, runOut: commandLines({ 777: WEB_LINE }) })
  files.set(WEB_PID, '777\n')
  await manager.stop('web')
  assert.deepEqual(calls, [PS(777)])
  assert.equal(files.has(WEB_PID), false)
})

test('every service method of every kind rejects an unknown service before doing anything', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const method of ['start', 'stop', 'restart', 'isActive']) {
      const { manager, files, calls, spawns, probes, writes, removed } = harness({ platform, active: () => true })
      files.set(`${WIN_STATE}\\run\\other.pid`, '4242\n')
      await assert.rejects(manager[method]('other'), /unknown service: other/, `${platform} ${method}`)
      assert.deepEqual([calls, spawns, probes, writes, removed], [[], [], [], [], []], `${platform} ${method} did nothing`)
    }
    const { manager } = harness({ platform })
    assert.throws(() => manager.describe('other'), /unknown service: other/, `${platform} describe`)
  }
})

test('detached stop never passes a corrupt pid to powershell or taskkill', async () => {
  for (const content of ['12abc\n', '0\n', '-1\n', '\n', "1') or (1=1\n", '1;calc\n']) {
    const { manager, files, calls } = harness({ platform: 'win32', active: () => true, runOut: () => WEB_LINE })
    files.set(WEB_PID, content)
    await manager.stop('web')
    assert.deepEqual(calls, [], `pid file ${JSON.stringify(content)}`)
    assert.equal(files.has(WEB_PID), false)
  }
})

test('detached stop rechecks after a failed taskkill: it throws and keeps the pid file while the process lives, and succeeds once it is gone', async () => {
  const { manager, files, calls } = harness({ platform: 'win32', runCode: file => file === 'taskkill' ? 1 : 0, runOut: commandLines({ 777: WEB_LINE }) })
  files.set(WEB_PID, '777\n')
  await assert.rejects(manager.stop('web'), /taskkill \/PID 777 failed/)
  assert.deepEqual(calls, [PS(777), TASKKILL(777), PS(777)])
  assert.equal(files.has(WEB_PID), true)
  const gone = harness({ platform: 'win32', runCode: file => file === 'taskkill' ? 128 : 0, runOut: commandLines({ 777: asked => asked === 0 ? WEB_LINE : '' }) })
  gone.files.set(WEB_PID, '777\n')
  await gone.manager.stop('web')
  assert.deepEqual(gone.calls, [PS(777), TASKKILL(777), PS(777)])
  assert.equal(gone.files.has(WEB_PID), false, 'taskkill failed but the process is gone, so stop succeeds')
})

test('detached install adds the HKCU Run value and starts both services; uninstall deletes it and stops both', async () => {
  let running = false
  const { manager, files, calls, spawns } = harness({ platform: 'win32', active: () => running,
    runOut: commandLines({ 4242: DECKD_LINE, 4243: WEB_LINE }) })
  await manager.install()
  const command = 'conhost.exe --headless "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\you\\hub\\bin\\fleetmates-deck.mjs" start'
  assert.deepEqual(calls, [['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'fleetmates-deck', '/t', 'REG_SZ', '/d', command, '/f']])
  assert.deepEqual(spawns.map(s => s.args[0]), ['C:\\Users\\you\\hub\\deckd\\main.mjs', 'C:\\Users\\you\\hub\\server\\main.mjs'])
  calls.length = 0
  running = true
  await manager.uninstall()
  assert.deepEqual(calls, [
    ['reg', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'fleetmates-deck', '/f'],
    PS(4242), TASKKILL(4242),
    PS(4243), TASKKILL(4243)
  ])
  assert.equal(files.has(`${WIN_STATE}\\run\\deckd.pid`), false)
})
