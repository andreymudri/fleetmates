import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { workingRoot } from './machines/session.mjs'
import { openDeckDb } from './db/index.mjs'
import { runRetention } from './db/retention.mjs'
import { createProjector } from './machines/projector.mjs'
import { createIngestor, startHookSocket } from './ingest/socket.mjs'
import { startSpoolDrain } from './ingest/spool.mjs'
import { connectDeckd as defaultConnectDeckd } from '../deckd/client.mjs'
import { setupPaths } from './setup/paths.mjs'
import { doctor } from './setup/doctor.mjs'
import { deckHookCommand, readSettings, transformHooks, writeSettings } from './setup/hooks.mjs'
import { createFleetmatesReader } from './adapters/fleetmates.mjs'
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
/**
 * Delay before deckd reconnect attempt `attempt + 1`: min(2^(attempt-1), 30) units of `baseMs` with
 * ±20% jitter (failures-and-loading 3.3, state-machines 4.2), bounded for setTimeout.
 * @param {number} attempt failed attempts so far, 1 or more
 * @param {number} baseMs one backoff unit, 1000 in production
 * @param {() => number} [random] source in [0, 1) for the jitter
 * @returns {number} milliseconds, at most 2^31-1
 */
export function reconnectDelay(attempt, baseMs, random = Math.random) {
  const steps = Math.min(2 ** Math.min(Math.max(0, attempt - 1), 5), 30)
  const jitter = 0.8 + 0.4 * random()
  return Math.max(0, Math.min(Math.round(baseMs * steps * jitter), 2 ** 31 - 1))
}
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
  let link = null
  let stopped = false
  let connecting = false
  let notifications
  let recording
  let notificationWork = Promise.resolve()
  let generation = 0
  let reconnect
  let retentionTimeout = null
  const offs = []
  const timers = []
  const healthState = { dep: 'deckd', state: 'down', reason: 'deckd_unavailable', since: now(), nextProbeAt: null, attempt: 0 }
  const health = () => [{ ...healthState }, ...['vault-mcp', 'scribed', 'notify', 'fleetmates'].map(dep => ({ dep, state: dep === 'scribed' ? recording?.snapshot().state ?? 'unknown' : 'unknown', reason: null, since: now(), nextProbeAt: null, attempt: 0 }))]
  const subscribers = new Set()
  const publish = event => {
    hub?.publish(event)
    for (const callback of subscribers) {
      try { callback(event) } catch {}
    }
  }
  const projector = createProjector({ store, now, publish })
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
  async function checks() { return doctor(paths, hookCommand, { run }) }
  const services = {
    checks,
    async installHooks() {
      try {
        const current = readSettings(paths.settings)
        const backupPath = writeSettings(paths.settings, current, transformHooks(current.value, hookCommand))
        return { check: (await checks()).find(check => check.id === 'hooks'), backupPath }
      } catch (error) { throw apiError(error instanceof SyntaxError ? 422 : 500, error instanceof SyntaxError ? 'validation_failed' : 'settings_io_failed') }
    },
    async startDependency(dep) {
      const result = dep === 'deckd' ? run('systemctl', ['--user', 'start', 'fleetmates-deckd.service']) : run(api.preferences().prefs.scribedCommand, ['start'])
      if (result.status !== 0) throw apiError(502, 'dependency_start_failed')
      if (dep === 'deckd') return retryDeckd()
      return { dep, state: 'checking', reason: null, since: now(), nextProbeAt: now(), attempt: 0 }
    },
    async retryDependency(dep) {
      if (dep === 'deckd') return retryDeckd()
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
    async rescan() {
      let found = 0
      // Only a scan root that cannot be read fails the rescan (settings_io_failed); a directory below it that
      // cannot be read is skipped, so one locked folder does not hide the repos beside it.
      function visit(dir, depth, top = false) {
        let entries = []
        let repo = false
        try {
          if (!fs.lstatSync(dir).isDirectory()) return
          repo = fs.existsSync(path.join(dir, '.git'))
          if (!repo && depth > 0) entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          if (top) throw apiError(500, 'settings_io_failed')
          return
        }
        if (repo) {
          const id = fs.realpathSync(dir)
          if (!store.get('SELECT id FROM repos WHERE id=?', id)) {
            let name = path.basename(dir)
            if (store.get('SELECT id FROM repos WHERE name=?', name)) name = `${path.basename(path.dirname(dir))}/${name}`
            const occupied = new Set(store.all('SELECT crew_slot FROM repos WHERE archived_at IS NULL AND crew_slot_shared=0').map(row => row.crew_slot))
            const slot = Array.from({ length: 9 }, (_, i) => i).find(slot => !occupied.has(slot))
            store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', id, name, slot ?? 0, slot === undefined ? 1 : 0, name, now())
            found++
            const row = api.repos().find(row => row.id === id)
            const at = now()
            publish({ seq: Number(store.appendEvent({ at, type: 'repo.upserted', entityId: id, data: row })), at, type: 'repo.upserted', data: row })
          }
          return
        }
        for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) visit(path.join(dir, entry.name), depth - 1)
      }
      let root
      try { root = scanRoot() } catch { throw apiError(500, 'settings_io_failed') }
      visit(root, 2, true)
      return { found }
    },
    ...options.services
  }
  api = createApi({ store, projector, paths, env, now, publish, services, runReader: reader, health, recorder: () => ({ state: recording?.isRecording() ? 'recording' : 'idle' }) })
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
  hub = createWsHub({ server, store, epoch, snapshot: api.snapshot, getToken: refreshToken, getPort: () => boundPort, now, heartbeatMs: options.heartbeatMs, helloTimeoutMs: options.helloTimeoutMs })
  let hooks
  let spool
  const bounded = async promise => {
    let timeout
    try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('deckd timed out')), options.deckdTimeoutMs ?? 2000) })]) }
    finally { clearTimeout(timeout) }
  }
  const request = (client, op, fields = {}) => bounded(client.request(op, fields))
  // One health.changed per connect outcome, so the banner's attempt and countdown advance (failures-and-loading 3.3).
  const stateEvent = (at = now()) => {
    publish({ seq: Number(store.appendEvent({ at, type: 'health.changed', data: { ...healthState } })), at, type: 'health.changed', data: { ...healthState } })
  }
  // "Retry now" and "Start": the API publishes the returned 'checking' row itself, so the probe runs on a
  // later macrotask and its outcome is published after that row; with no probe to run, republish the true state.
  function retryDeckd() {
    setImmediate(() => {
      if (stopped) return
      if (link || !env.XDG_RUNTIME_DIR) return stateEvent()
      clearTimeout(reconnect)
      void connect()
    })
    return { ...healthState, state: 'checking', reason: null, nextProbeAt: now() }
  }
  function disconnect() {
    generation++
    for (const off of offs.splice(0)) off()
    const previous = link
    link = null
    previous?.close()
    const at = now()
    if (healthState.state !== 'down' || healthState.reason !== 'deckd_unavailable') healthState.since = at
    healthState.state = 'down'
    healthState.reason = 'deckd_unavailable'
    // Each disconnect or failed connect is one attempt: a live link that drops reports attempt 1.
    healthState.attempt++
    const delay = reconnectDelay(healthState.attempt, reconnectMs, random)
    healthState.nextProbeAt = stopped ? null : at + delay
    if (!stopped) { stateEvent(at)
      clearTimeout(reconnect)
      reconnect = setTimeout(() => { void connect() }, delay)
      reconnect.unref() }
  }
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
  function publishSession(id) {
    const at = now()
    const projection = projector.snapshot()
    for (const [type, data] of [['session.upserted', projection.sessions.find(row => row.id === id)], ['counts', projection.counts]]) {
      publish({ seq: Number(store.appendEvent({ at, type, entityId: id, data })), at, type, data })
    }
  }
  function restorePty(pty) {
    if (store.get('SELECT id FROM sessions WHERE pty_id=? AND alive=1', pty.ptyId)) return
    const repoId = workingRoot(pty.cwd)
    if (!store.get('SELECT id FROM repos WHERE id=?', repoId)) {
      let name = path.basename(repoId)
      if (store.get('SELECT id FROM repos WHERE name=?', name)) name = repoId
      const occupied = new Set(store.all('SELECT crew_slot FROM repos WHERE archived_at IS NULL AND crew_slot_shared=0').map(row => row.crew_slot))
      const slot = Array.from({ length: 9 }, (_, i) => i).find(slot => !occupied.has(slot))
      store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repoId, name, slot ?? 0, slot === undefined ? 1 : 0, name, now())
    }
    const id = randomUUID()
    const at = pty.startedAt ?? now()
    store.run('INSERT INTO sessions(id,origin,pty_id,process_key,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,joined_mid_life,started_at,last_input_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, pty.origin ?? 'wrapped', pty.ptyId, pty.ptyId, repoId, pty.cwd, 'starting', at, at, at, 1, 1, at, pty.lastInputFrom ?? null)
    publishSession(id)
  }
  function applyInput(input) {
    const row = store.get('SELECT id FROM sessions WHERE pty_id=? AND alive=1', input.ptyId)
    if (!row) return
    store.run('UPDATE sessions SET last_input_from=?,last_input_name=? WHERE id=?', input.source.kind === 'terminal' ? 'terminal' : 'browser', input.source.name ?? null, row.id)
    publishSession(row.id)
  }
  function applyExit(exit) {
    const row = store.get('SELECT id FROM sessions WHERE pty_id=? AND alive=1', exit.ptyId)
    if (row) projector.signal(row.id, { type: 'exit', code: exit.code, signal: exit.signal }, exit.at ?? now())
  }
  async function connect() {
    if (stopped || connecting || link || !env.XDG_RUNTIME_DIR) return
    connecting = true
    const turn = generation
    let client
    try {
      client = await bounded(connectDeckd({ runtimeDir: env.XDG_RUNTIME_DIR, kind: 'server' }).then(candidate => {
        if (stopped || turn !== generation) { candidate.close()
          throw Error('stale connection') }
        return candidate
      }))
      if (stopped || turn !== generation) { client.close()
        return }
      link = client
      offs.push(client.on('close', disconnect), client.on('exit', applyExit), client.on('spawned', restorePty), client.on('input', applyInput))
      const [live, ended] = await Promise.all([request(client, 'list'), request(client, 'exits', { since: 0 })])
      if (stopped || link !== client) return
      for (const pty of live.ptys ?? []) restorePty(pty)
      for (const exit of ended.exits ?? []) applyExit(exit)
      const ids = new Set((live.ptys ?? []).map(pty => pty.ptyId))
      for (const row of store.all('SELECT id,pty_id FROM sessions WHERE alive=1 AND origin<>?', 'observed')) if (!ids.has(row.pty_id)) projector.signal(row.id, { type: 'lost' }, now())
      healthState.state = 'ok'
      healthState.reason = null
      healthState.since = now()
      healthState.attempt = 0
      healthState.nextProbeAt = null
      stateEvent()
    } catch {
      // A drop during the handshake already ran disconnect() from the close listener (it bumps the
      // generation); counting this failure again would report two attempts for one drop.
      if (!stopped && turn === generation) disconnect()
      client?.close()
    } finally { connecting = false }
  }
  async function close() {
    if (stopped) return
    stopped = true
    generation++
    clearTimeout(reconnect)
    if (retentionTimeout !== null) retentionTimer.clear(retentionTimeout)
    retentionTimeout = null
    for (const timer of timers) clearInterval(timer)
    recording?.stop()
    await notificationWork.catch(() => {})
    for (const off of offs.splice(0)) off()
    link?.close()
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
    await connect()
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
    const rotation = setInterval(() => { try { refreshToken() } catch {} }, tokenPollMs)
    const tick = setInterval(() => { projector.tick(now()) }, 5000)
    const ping = setInterval(() => { if (link) request(link, 'ping').catch(() => disconnect()) }, 5000)
    for (const timer of [rotation, tick, ping]) { timer.unref()
      timers.push(timer) }
  } catch (error) { await close()
    throw error }
  return {
    server, store, projector, ingest, epoch, publish, notifications, recording, snapshot: api.snapshot, preferences: api.preferences,
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
