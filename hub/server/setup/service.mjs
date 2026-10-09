import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'
import { LAUNCHD_LABELS, UNIT_NAMES, renderPlist, renderUnit, writeUnit } from './units.mjs'

const SERVICES = ['deckd', 'web']
const ENTRIES = { deckd: ['deckd', 'main.mjs'], web: ['server', 'main.mjs'] }
const SYSTEMD_UNITS = { deckd: 'fleetmates-deckd.service', web: 'fleetmates-deck.service' }
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'fleetmates-deck'

function defaultRun(file, args) {
  const result = childProcess.spawnSync(file, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  return Promise.resolve({ code: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' })
}

function checkService(service) {
  if (!SERVICES.includes(service)) throw new Error(`unknown service: ${service}`)
}

/**
 * One service manager for the deckd and web services: systemd user units on linux, LaunchAgents on darwin, and
 * detached processes with an HKCU Run autostart value on win32. The implementation is chosen from `platform`.
 */
export function createServiceManager({
  platform = process.platform, paths, nodePath = process.execPath, hubPath, run = defaultRun, spawn = childProcess.spawn,
  uid = process.getuid?.() ?? null, probe, writeFile = fs.promises.writeFile, mkdir = fs.promises.mkdir,
  readFile = fs.promises.readFile, rm = fs.promises.rm, env = process.env
}) {
  const entry = service => path.join(hubPath, ...ENTRIES[service])
  const must = async (file, args) => {
    const result = await run(file, args)
    if (result.code !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr?.trim() || `exit ${result.code}`}`)
    return result
  }
  // Every method validates its service before doing anything, and every method is async.
  const guard = fn => async service => { checkService(service); return fn(service) }

  if (platform === 'linux') {
    return {
      kind: 'systemd',
      async install() {
        let changedUnit = false
        let webUnitChanged = false
        for (const name of UNIT_NAMES) {
          const changed = writeUnit(path.join(paths.units, name), renderUnit(name, nodePath, hubPath))
          changedUnit = changed || changedUnit
          if (name === SYSTEMD_UNITS.web) webUnitChanged = changed
        }
        if (changedUnit) await must('systemctl', ['--user', 'daemon-reload'])
        if (webUnitChanged) await must('systemctl', ['--user', 'try-restart', SYSTEMD_UNITS.web])
        await must('systemctl', ['--user', 'enable', '--now', ...UNIT_NAMES])
      },
      start: guard(service => must('systemctl', ['--user', 'start', SYSTEMD_UNITS[service]]).then(() => {})),
      stop: guard(service => must('systemctl', ['--user', 'stop', SYSTEMD_UNITS[service]]).then(() => {})),
      restart: guard(service => must('systemctl', ['--user', 'restart', SYSTEMD_UNITS[service]]).then(() => {})),
      isActive: guard(async service => (await run('systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_UNITS[service]])).code === 0),
      async uninstall() {
        await run('systemctl', ['--user', 'disable', '--now', ...UNIT_NAMES])
        for (const name of UNIT_NAMES) await rm(path.join(paths.units, name), { force: true })
        await run('systemctl', ['--user', 'daemon-reload'])
      },
      describe(service) { checkService(service); return `journalctl --user -u ${SYSTEMD_UNITS[service]}` }
    }
  }

  if (platform === 'darwin') {
    const agents = path.join(paths.home, 'Library', 'LaunchAgents')
    const plist = service => path.join(agents, `${LAUNCHD_LABELS[service]}.plist`)
    const domain = () => {
      if (uid === null || uid === undefined) throw new Error('launchd needs the user id for the gui domain')
      return `gui/${uid}`
    }
    const target = service => `${domain()}/${LAUNCHD_LABELS[service]}`
    return {
      kind: 'launchd',
      async install() {
        await mkdir(agents, { recursive: true, mode: 0o700 })
        await mkdir(paths.logs, { recursive: true, mode: 0o700 })
        for (const service of SERVICES) await writeFile(plist(service), renderPlist(LAUNCHD_LABELS[service], nodePath, entry(service), paths.logs), { mode: 0o644 })
        for (const service of SERVICES) {
          // A loaded job must be booted out before bootstrap reads the new plist; not loaded is not an error.
          await run('launchctl', ['bootout', target(service)])
          await must('launchctl', ['bootstrap', domain(), plist(service)])
        }
      },
      start: guard(service => must('launchctl', ['kickstart', target(service)]).then(() => {})),
      restart: guard(service => must('launchctl', ['kickstart', '-k', target(service)]).then(() => {})),
      stop: guard(service => must('launchctl', ['kill', 'SIGTERM', target(service)]).then(() => {})),
      isActive: guard(service => probe(service)),
      async uninstall() {
        for (const service of SERVICES) await run('launchctl', ['bootout', target(service)])
        for (const service of SERVICES) await rm(plist(service), { force: true })
      },
      describe(service) {
        checkService(service)
        return `logs: ${path.join(paths.logs, `${service}.out.log`)}, ${path.join(paths.logs, `${service}.err.log`)}`
      }
    }
  }

  if (platform === 'win32') {
    const runDir = path.join(paths.state, 'run')
    const pidFile = service => path.join(runDir, `${service}.pid`)
    const logFile = service => path.join(paths.logs, `${service}.log`)
    const launch = async service => {
      await mkdir(paths.logs, { recursive: true, mode: 0o700 })
      await mkdir(runDir, { recursive: true, mode: 0o700 })
      const fd = fs.openSync(logFile(service), 'a', 0o600)
      let child
      try {
        child = spawn(nodePath, [entry(service)], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env })
      } finally { fs.closeSync(fd) }
      if (!child?.pid) throw new Error(`could not start ${service}`)
      child.unref()
      await writeFile(pidFile(service), `${child.pid}\n`, { mode: 0o600 })
    }
    const stop = async service => {
      let pid
      try { pid = String(await readFile(pidFile(service), 'utf8')).trim() } catch (error) { if (error.code === 'ENOENT') return; throw error }
      // A pid file left by a crash or a reboot may name an unrelated process tree, so kill only while the probe answers.
      if (await probe(service) && /^[1-9][0-9]*$/.test(pid)) {
        const result = await run('taskkill', ['/PID', pid, '/T', '/F'])
        if (result.code !== 0 && await probe(service)) throw new Error(`taskkill /PID ${pid} failed: ${result.stderr?.trim() || `exit ${result.code}`}`)
      }
      await rm(pidFile(service), { force: true })
    }
    return {
      kind: 'detached',
      async install() {
        const command = `conhost.exe --headless "${nodePath}" "${path.join(hubPath, 'bin', 'fleetmates-deck.mjs')}" start`
        await must('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f'])
        for (const service of SERVICES) if (!await probe(service)) await launch(service)
      },
      start: guard(async service => { if (!await probe(service)) await launch(service) }),
      stop: guard(stop),
      restart: guard(async service => { await stop(service); await launch(service) }),
      isActive: guard(service => probe(service)),
      async uninstall() {
        await run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
        for (const service of SERVICES) await stop(service)
      },
      describe(service) { checkService(service); return `logs: ${logFile(service)}` }
    }
  }

  throw new Error(`no service manager for platform ${platform}`)
}
