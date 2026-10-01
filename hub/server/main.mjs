import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { openDeckDb } from './db/index.mjs'
import { runRetention } from './db/retention.mjs'
import { createProjector } from './machines/projector.mjs'
import { createIngestor, startHookSocket } from './ingest/socket.mjs'
import { startSpoolDrain } from './ingest/spool.mjs'
import { connectDeckd as defaultConnectDeckd } from '../deckd/client.mjs'
import { setupPaths } from './setup/paths.mjs'
import { doctor } from './setup/doctor.mjs'
import { checkHooks, deckHookCommand, readSettings, transformHooks, writeSettings } from './setup/hooks.mjs'
import { scanRepos } from './adapters/repos.mjs'
import { createDeckdLink } from './pty/link.mjs'
import { createFleetmatesReader, taskForCwd } from './adapters/fleetmates.mjs'
import { createApi } from './http/api.mjs'
import { createRouter, apiError } from './http/router.mjs'
import { readToken } from './http/auth.mjs'
import { createWsHub } from './ws/hub.mjs'
const builtSpa = fileURLToPath(new URL('../web/dist/', import.meta.url))
function runCommand(file, args, env) {
  try { return { status: 0, stdout: execFileSync(file, args, { encoding: 'utf8', timeout: 5000, env, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' } }
  catch (error) { return { status: error.status ?? 1, stdout: '', stderr: '' } }
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const info = fs.lstatSync(dir)
  if (!info.isDirectory() || info.uid !== process.getuid()) throw Error('deck directory must be private and owner-owned')
  fs.chmodSync(dir, 0o700)
}
export { reconnectDelay } from './pty/link.mjs'
/**
 * Milliseconds from `at` to the next 04:10 local time, when the daily retention job runs (06-storage 6).
 * @param {number} at epoch milliseconds
 * @returns {number} milliseconds, never 0: at exactly 04:10 the next run is the following day's
 */
export function nextRetentionDelay(at) {
  const date = new Date(at)
  let next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 4, 10).getTime()
  if (next <= at) next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 4, 10).getTime()
  return next - at
}
const defaultRetentionTimer = {
  set(fn, ms) { const timer = setTimeout(fn, ms)
    timer.unref()
    return timer },
  clear(timer) { clearTimeout(timer) }
}
/** Create a deck server with injectable processes, readers and dependency services. */
export async function createDeckServer(options = {}) {
  const { env = process.env, host = '127.0.0.1', now = Date.now, connectDeckd = defaultConnectDeckd,
    reconnectMs = 1000, random = Math.random, tokenPollMs = 250, runCommand: command = runCommand,
    retentionTimer = defaultRetentionTimer } = options
  if (host !== '127.0.0.1') throw Error('deck server requires IPv4 loopback 127.0.0.1')
  const paths = options.paths ?? setupPaths(env)
  privateDir(paths.state)
  const token = readToken(paths.token)
  let currentToken = token
  let tokenValid = true
  let config = {}
  try { config = JSON.parse(fs.readFileSync(path.join(paths.config, 'config.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const port = options.port ?? (env.DECK_PORT === undefined ? config.port ?? 47800 : Number(env.DECK_PORT))
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid DECK_PORT')
  let boundPort = port
  const store = options.store ?? openDeckDb(path.join(paths.state, 'deck.db'))
  const epoch = store.get('SELECT value FROM meta WHERE key=?', 'epoch').value
  let hub
  let api
  let stopped = false
  let notifications
  let recording
  let notificationWork = Promise.resolve()
  let retentionTimeout = null
  const timers = []
  let link
  let hooksState
  const health = () => [link.health(), { ...hooksState }, ...['vault-mcp', 'scribed', 'notify', 'fleetmates'].map(dep => ({ dep, state: dep === 'scribed' ? recording?.snapshot().state ?? 'unknown' : 'unknown', reason: null, since: now(), nextProbeAt: null, attempt: 0 }))]
  const subscribers = new Set()
  const publish = event => {
    hub?.publish(event)
    for (const callback of subscribers) {
      try { callback(event) } catch {}
    }
  }
  const projector = createProjector({ store, now, publish, locateTask: taskForCwd })
  link = createDeckdLink({ env, connectDeckd, reconnectMs, random, now, store, projector, publish, timeoutMs: options.deckdTimeoutMs ?? 2000 })
  const ingest = createIngestor({ now, onEvent: envelope => projector.applyHooks([envelope]), onRejected: row => store.run('INSERT INTO rejected_events(received_at,via,reason,raw) VALUES(?,?,?,?)', row.receivedAt, row.via, row.reason, '') })
  const scanRoot = () => {
    const root = api?.preferences().prefs.scanRoot ?? config.scanRoot ?? '~/dev'
    return root.startsWith('~/') ? path.join(paths.home, root.slice(2)) : path.resolve(root)
  }
  const repoRoots = () => store.all('SELECT id FROM repos WHERE archived_at IS NULL').map(row => row.id)
  let rootsKey = ''
  let currentReader
  const reader = options.runReader ?? {
    async list() {
      const roots = repoRoots().sort()
      const key = JSON.stringify(roots)
      if (!currentReader || key !== rootsKey) {
        currentReader?.close()
        currentReader = createFleetmatesReader({ repoRoots: roots })
        rootsKey = key
      }
      return currentReader.list()
    },
    close() { currentReader?.close() }
  }
  const processEnv = { ...env }
  for (const key of Object.keys(processEnv)) if (/TOKEN|SECRET|PASSWORD|AUTHORIZATION/i.test(key)) delete processEnv[key]
  const run = (file, args) => command(file, args, processEnv)
  const hookCommand = deckHookCommand(process.execPath, paths.hook)
  // The hooks health row (owner decision 2026-10-01): computed now, rechecked after every rescan and hook
  // install, and published as health.changed only when its state or reason changes.
  hooksState = { dep: 'hooks', ...checkHooks(paths, hookCommand), since: now(), nextProbeAt: null, attempt: 0 }
  function recheckHooks() {
    const next = checkHooks(paths, hookCommand)
    if (next.state === hooksState.state && next.reason === hooksState.reason) return
    const at = now()
    hooksState = { ...hooksState, ...next, since: at }
    publish({ seq: Number(store.appendEvent({ at, type: 'health.changed', data: { ...hooksState } })), at, type: 'health.changed', data: { ...hooksState } })
  }
  async function checks() { return doctor(paths, hookCommand, { run }) }
  const services = {
    checks,
    async installHooks() {
      try {
        const current = readSettings(paths.settings)
        const backupPath = writeSettings(paths.settings, current, transformHooks(current.value, hookCommand))
        return { check: (await checks()).find(check => check.id === 'hooks'), backupPath }
      } catch (error) { throw apiError(error instanceof SyntaxError ? 422 : 500, error instanceof SyntaxError ? 'validation_failed' : 'settings_io_failed') }
      finally { recheckHooks() }
    },
    async startDependency(dep) {
      const result = dep === 'deckd' ? run('systemctl', ['--user', 'start', 'fleetmates-deckd.service']) : run(api.preferences().prefs.scribedCommand, ['start'])
      if (result.status !== 0) throw apiError(502, 'dependency_start_failed')
      if (dep === 'deckd') return link.retry()
      return { dep, state: 'checking', reason: null, since: now(), nextProbeAt: now(), attempt: 0 }
    },
    async retryDependency(dep) {
      if (dep === 'deckd') return link.retry()
      return { dep, state: 'checking', reason: null, since: now(), nextProbeAt: now(), attempt: 0 }
    },
    async notify() {
      if (notifications) {
        const result = await notifications.testPing()
        if (!result.ok) throw apiError(502, 'notify_failed', { exitCode: result.error?.exitCode ?? null })
        return { ok: true, via: 'notify-send' }
      }
      const result = run('notify-send', ['--app-name=fleetmates deck', '--urgency=normal', '--', 'fleetmates deck', 'Test ping'])
      if (result.status !== 0) throw apiError(502, 'notify_failed', { exitCode: result.status })
      return { ok: true, via: 'notify-send' }
    },
    async disk(cwd) {
      const mounts = [...new Set([cwd, paths.home])].map(location => {
        const info = fs.statfsSync(location)
        return { mount: location, sizeBytes: info.blocks * info.bsize, usedBytes: (info.blocks - info.bfree) * info.bsize, availBytes: info.bavail * info.bsize }
      })
      return { cwd, mounts }
    },
    // Opens one resolved, checked absolute path (open.mjs): argv only, no shell, the token-free environment.
    // The opener is detached and never awaited, since xdg-open may run the editor in the foreground; only a
    // failure to spawn it (ENOENT, EACCES) is reported.
    open(file) {
      return new Promise((resolve, reject) => {
        let child
        try { child = spawn('xdg-open', [file], { env: processEnv, stdio: 'ignore', detached: true }) }
        catch { return reject(apiError(502, 'open_failed')) }
        child.once('error', () => reject(apiError(502, 'open_failed')))
        child.once('spawn', () => { child.unref()
          resolve() })
      })
    },
    async rescan() {
      try {
        let root
        try { root = scanRoot() } catch { throw apiError(500, 'settings_io_failed') }
        return scanRepos({ store, root, now, onInsert: id => {
          const row = api.repos().find(row => row.id === id)
          const at = now()
          publish({ seq: Number(store.appendEvent({ at, type: 'repo.upserted', entityId: id, data: row })), at, type: 'repo.upserted', data: row })
        } })
      } finally { recheckHooks() }
    },
    ...options.services
  }
  api = createApi({ store, projector, paths, env, now, publish, services, link, runReader: reader, health, recorder: () => ({ state: recording?.isRecording() ? 'recording' : 'idle' }) })
  function refreshToken() {
    try {
      const next = readToken(paths.token)
      if (next !== currentToken || !tokenValid) { currentToken = next
        tokenValid = true
        hub?.rotate() }
    } catch { if (tokenValid) hub?.rotate()
      tokenValid = false }
    if (!tokenValid) throw apiError(401, 'unauthorized')
    return currentToken
  }
  const server = http.createServer(createRouter({ api: api.route, staticDir: options.staticDir ?? builtSpa, getToken: refreshToken, getPort: () => boundPort }))
  hub = createWsHub({ server, store, epoch, link, snapshot: api.snapshot, getToken: refreshToken, getPort: () => boundPort, now, heartbeatMs: options.heartbeatMs, helloTimeoutMs: options.helloTimeoutMs })
  let hooks
  let spool
  // The 30-day retention job (06-storage 6): once at start, then daily at 04:10 local. Each removed session's
  // session.removed event goes to open tabs as { id }. A run that throws is rolled back by runRetention and
  // skipped here; the next daily run is still scheduled.
  function retention() {
    const before = Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq)
    try { runRetention(store, { now: now() }) } catch { return }
    for (const row of store.all('SELECT seq,at,entity_id FROM events WHERE seq>? AND type=? ORDER BY seq', before, 'session.removed')) {
      publish({ seq: Number(row.seq), at: row.at, type: 'session.removed', data: { id: row.entity_id } })
    }
  }
  function scheduleRetention() {
    if (stopped) return
    retentionTimeout = retentionTimer.set(() => {
      retentionTimeout = null
      if (stopped) return
      retention()
      scheduleRetention()
    }, nextRetentionDelay(now()))
  }
  async function close() {
    if (stopped) return
    stopped = true
    link.close()
    if (retentionTimeout !== null) retentionTimer.clear(retentionTimeout)
    retentionTimeout = null
    for (const timer of timers) clearInterval(timer)
    recording?.stop()
    await notificationWork.catch(() => {})
    spool?.close()
    ingest.close()
    reader.close?.()
    subscribers.clear()
    await hub.close()
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await hooks?.close()
    if (!options.store) store.close()
  }
  try {
    privateDir(paths.spool)
    retention()
    scheduleRetention()
    if (options.notifications !== false) {
      const [{ createNotifier }, { createNotificationMachine }, { createScribedStatus }] = await Promise.all([
        import('./adapters/notify.mjs'), import('./machines/notification.mjs'), import('./adapters/scribed-status.mjs')
      ])
      recording = options.scribedStatus ?? createScribedStatus({
        socketPath: env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'turbidassist.sock') : null,
        now, ...(options.scribedProbe ? { status: options.scribedProbe } : {}),
        pollMs: options.scribedPollMs ?? 2000, timeoutMs: options.scribedTimeoutMs ?? 1000
      })
      notifications = createNotificationMachine({ store, now, publish,
        notifier: options.notifier ?? createNotifier({ env: processEnv }), recording: () => recording.isRecording() })
      await recording.start()
    }
    spool = await startSpoolDrain({ dir: paths.spool, ingest })
    if (env.XDG_RUNTIME_DIR) hooks = await startHookSocket({ runtimeDir: env.XDG_RUNTIME_DIR, ingest })
    await link.start()
    if (notifications) {
      await notifications.tick(now())
      let busy = false
      const timer = setInterval(() => {
        if (busy || stopped) return
        busy = true
        notificationWork = notifications.tick(now()).catch(() => {}).finally(() => { busy = false })
      }, options.notificationTickMs ?? 500)
      timer.unref()
      timers.push(timer)
    }
    // run.updated (05-api 3.4): re-read the runs every runPollMs and publish each run whose JSON changed
    // since the previous read. The first read has nothing to compare with, so it publishes every run once.
    const runJson = new Map()
    let runBusy = false
    const runPoll = setInterval(() => {
      if (runBusy || stopped) return
      runBusy = true
      Promise.resolve().then(() => reader.list()).then(api.withLeads).then(list => {
        if (stopped) return
        for (const row of list) {
          const key = JSON.stringify([row.repoId, row.runId])
          const text = JSON.stringify(row)
          if (runJson.get(key) === text) continue
          runJson.set(key, text)
          const at = now()
          publish({ seq: Number(store.appendEvent({ at, type: 'run.updated', entityId: row.runId, data: row })), at, type: 'run.updated', data: row })
        }
      }).catch(() => {}).finally(() => { runBusy = false })
    }, options.runPollMs ?? 60_000)
    const rotation = setInterval(() => { try { refreshToken() } catch {} }, tokenPollMs)
    const tick = setInterval(() => { projector.tick(now()) }, 5000)
    for (const timer of [runPoll, rotation, tick]) { timer.unref()
      timers.push(timer) }
  } catch (error) { await close()
    throw error }
  return {
    server, store, projector, ingest, epoch, publish, link, notifications, recording, snapshot: api.snapshot, preferences: api.preferences,
    address: () => server.address(), close,
    /** Subscribe a notification consumer to committed events; return its removal function. */
    subscribe(callback) { subscribers.add(callback)
      return () => subscribers.delete(callback) },
    /** Bind the HTTP server on IPv4 loopback after startup recovery. */
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject)
        server.listen(port, host, () => { server.off('error', reject)
        boundPort = server.address().port
        resolve() }) })
      return server.address()
    }
  }
}
/** Recover private state and start serving the M1 deck. */
export async function startDeckServer(options = {}) {
  const deck = await createDeckServer(options)
  try { await deck.listen()
    return deck } catch (error) { await deck.close()
    throw error }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startDeckServer().then(deck => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { deck.close().catch(() => { process.exitCode = 1 }) })
  }).catch(() => { process.stderr.write('deck server startup failed\n')
    process.exitCode = 1 })
}
