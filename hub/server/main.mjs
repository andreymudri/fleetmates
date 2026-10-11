import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { openDeckDb } from './db/index.mjs'
import { runRetention } from './db/retention.mjs'
import { createProjector, requestView } from './machines/projector.mjs'
import { autoArchiveCandidates } from './machines/archive.mjs'
import { createIngestor, startHookSocket } from './ingest/socket.mjs'
import { startSpoolDrain } from './ingest/spool.mjs'
import { hookVersionOutdated } from './ingest/validate.mjs'
import { connectDeckd as defaultConnectDeckd } from '../deckd/client.mjs'
import { setupPaths } from './setup/paths.mjs'
import { doctor } from './setup/doctor.mjs'
import { checkHooks, deckHookCommand, readSettings, transformHooks, writeSettings } from './setup/hooks.mjs'
import { scanRepos } from './adapters/repos.mjs'
import { createDeckdLink } from './pty/link.mjs'
import { createFleetmatesReader, taskForCwd } from './adapters/fleetmates.mjs'
import { initializeLedgerTimeline, syncLedgerTimeline } from './ledger-timeline.mjs'
import { createApi } from './http/api.mjs'
import { createRouter, apiError } from './http/router.mjs'
import { parsePublicOrigin, readToken } from './http/auth.mjs'
import { createRemoteAccess } from './http/remote-pass.mjs'
import { createWsHub } from './ws/hub.mjs'
import { authorize } from './http/auth.mjs'
import { openInBrowser } from './setup/browser.mjs'
import { createTiersStore } from './approvals/tiers-store.mjs'
import { setActiveTiers, maxTier } from './approvals/tiers.mjs'
import { scanInstallRequest } from './approvals/extension-scan.mjs'
import { applyScreen, fillConfirmLabel, raiseTiers } from './approvals/request-updates.mjs'
import { createDeliverer, recordAnswered, recover as recoverDeliveries } from './approvals/deliver.mjs'
import { createRules, offers as ruleOffers, recordAllow, ruleThreshold } from './approvals/rules.mjs'
import { record as recordAudit } from './approvals/audit.mjs'
import { countFor } from './approvals/confirm-count.mjs'
import { classifyHook } from './machines/request.mjs'
import { ScribedUnavailable, SOCKET_NAME, createScribedClient } from './adapters/scribed.mjs'
import { createConfigWatcher, locateConfig, readConfig } from './meetings/config.mjs'
import { createRecorder } from './meetings/recorder.mjs'
import { createPostWatch } from './meetings/post-watch.mjs'
import { createMeetingAsk } from './meetings/ask.mjs'
import { startScribed } from './meetings/start-scribed.mjs'
import { createVaultClient } from './adapters/vault-mcp.mjs'
import { createVaultService, localDate } from './vault/service.mjs'
import { refreshCaptures } from './vault/captures.mjs'
import { createAskEngine } from './ask/engine.mjs'
import { createAskService } from './ask/service.mjs'
import { createServiceManager } from './setup/service.mjs'
import { openUrlArgv, privateFileProblem, runtimeBase } from '../platform/index.mjs'
const builtSpa = fileURLToPath(new URL('../web/dist/', import.meta.url))
const deckVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
// Consecutive envelopes at the current deckHookVersion that return an outdated hooks row to ok.
const currentHookRun = 3
function runCommand(file, args, env) {
  try { return { status: 0, stdout: execFileSync(file, args, { encoding: 'utf8', timeout: 5000, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }), stderr: '' } }
  catch (error) { return { status: error.status ?? 1, stdout: '', stderr: '' } }
}
/**
 * A scribed client for a server without `XDG_RUNTIME_DIR`, or off linux, where scribed does not run: every call fails
 * as unavailable with `message`, so nothing falls back to the process environment's socket (scribed.mjs
 * `defaultSocketPath` reads `process.env`).
 */
function unavailableScribed(message) {
  const fail = async () => { throw new ScribedUnavailable(message) }
  return {
    status: fail, start: fail, stop: fail, tail: fail, history: fail, ask: fail,
    subscribe({ onClose = () => {} } = {}) {
      let closed = false
      const finish = error => { if (!closed) { closed = true
        onClose(error) } }
      queueMicrotask(() => finish(new ScribedUnavailable(message)))
      return { close: () => finish(null) }
    },
    stats: () => ({ unknownTypes: 0 })
  }
}
/**
 * The recorder face of an injected `scribedStatus` stand-in (`{ start, stop, snapshot, isRecording }`, as
 * answer-api.test.mjs passes it): quiet mode and the health row read it; it starts and stops nothing.
 */
function standInRecorder(status, now) {
  const view = () => ({ state: status.isRecording() ? 'recording' : 'idle', meetingId: null, tag: null, confidential: false, elapsedS: 0, since: null,
    startedAt: null, apps: [], quiet: status.isRecording(), slow: false, lost: false, lastError: null })
  const health = () => ({ dep: 'scribed', state: status.snapshot()?.state ?? 'unknown', reason: null, since: now(), nextProbeAt: null, attempt: 0 })
  return {
    view, health, isRecording: () => status.isRecording(), ring: () => [],
    start: async () => { throw apiError(503, 'scribed_unavailable') },
    stop: () => { throw apiError(409, 'not_recording') },
    probeNow: async () => health(),
    close: () => status.stop?.()
  }
}
const insideDir = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
const realOrResolved = file => {
  try { return fs.realpathSync.native(file) } catch { return path.resolve(file) }
}
/**
 * Create `dir` and make it private: on POSIX it must be a directory owned by `uid` (a permissive mode is tightened to
 * 0700, not refused); win32 has no owner uid to check.
 */
function privateDir(dir, { platform, uid }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const info = fs.lstatSync(dir)
  if (!info.isDirectory() || privateFileProblem(info, { platform, uid, mode: info.mode & 0o777 })) throw Error('deck directory must be private and owner-owned')
  fs.chmodSync(dir, 0o700)
}
/**
 * Open one resolved, checked absolute path with the platform opener (openUrlArgv): argv only, no shell, detached and
 * never awaited, since the opener may run an editor in the foreground; only a failure to spawn it is reported.
 * @param {string} file
 * @param {{ platform?: string, env?: Record<string, string | undefined>, spawn?: typeof spawn }} [opts]
 * @returns {Promise<void>}
 */
export function openPath(file, { platform = process.platform, env = process.env, spawn: spawnOpener = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = openUrlArgv(file, { platform })
    let child
    try { child = spawnOpener(command, args, { env, stdio: 'ignore', detached: true, ...(platform === 'win32' ? { windowsVerbatimArguments: true, windowsHide: true } : {}) }) }
    catch { return reject(apiError(502, 'open_failed')) }
    child.once('error', () => reject(apiError(502, 'open_failed')))
    child.once('spawn', () => { child.unref()
      resolve() })
  })
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
    retentionTimer = defaultRetentionTimer, platform = process.platform, uid = process.getuid?.() ?? null } = options
  if (host !== '127.0.0.1') throw Error('deck server requires IPv4 loopback 127.0.0.1')
  const paths = options.paths ?? setupPaths(env, { platform })
  const owner = { platform, uid }
  privateDir(paths.state, owner)
  const token = readToken(paths.token, owner)
  let currentToken = token
  let tokenValid = true
  let config = {}
  try { config = JSON.parse(fs.readFileSync(path.join(paths.config, 'config.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const port = options.port ?? (env.DECK_PORT === undefined ? config.port ?? 47800 : Number(env.DECK_PORT))
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid DECK_PORT')
  // Remote access (08-security 4.2): opt in with one exact public origin, resolved as the port is. Without it the
  // deck answers IPv4 loopback only, exactly as before, and the passphrase exchange does not exist.
  // Resolved in the shape the port above is resolved: the option, then DECK_PUBLIC_ORIGIN, then config.json. A set
  // but empty variable is not an absent one; it means loopback only, so a drop-in turns remote access off without
  // editing config.json.
  const publicOrigin = parsePublicOrigin(options.publicOrigin ?? (env.DECK_PUBLIC_ORIGIN === undefined ? config.publicOrigin ?? null : env.DECK_PUBLIC_ORIGIN))
  const remote = createRemoteAccess({ file: path.join(paths.state, 'remote-pass.json'), now, ...owner, ...(options.remoteAccess ?? {}) })
  let boundPort = port
  const store = options.store ?? openDeckDb(path.join(paths.state, 'deck.db'), owner)
  const epoch = store.get('SELECT value FROM meta WHERE key=?', 'epoch').value
  let hub
  let api
  let stopped = false
  let notifications
  let recorder
  let notificationWork = Promise.resolve()
  let retentionTimeout = null
  const timers = []
  let link
  let hooksState
  let vaultClient = null
  let vaultService = null
  let askService = null
  let vaultKey = null
  let vaultWork = Promise.resolve()
  let captureWork = Promise.resolve()
  let captureBusy = false
  let vaultState = { dep: 'vault-mcp', state: 'down', reason: 'VAULT_PATH is not set', since: now(), nextProbeAt: null, attempt: 0, version: null, capabilities: [] }
  const vaultHealth = () => vaultClient?.health() ?? { ...vaultState }
  // scribed runs only on linux; elsewhere its row is down with the reason `unsupported on <platform>`.
  const scribedUnsupported = platform === 'linux' ? null : `unsupported on ${platform}`
  const scribedHealth = () => scribedUnsupported ? { ...recorder.health(), state: 'down', reason: scribedUnsupported, nextProbeAt: null } : recorder.health()
  const health = () => [link.health(), { ...hooksState }, ...['vault-mcp', 'scribed', 'notify', 'fleetmates'].map(dep => dep === 'vault-mcp' ? vaultHealth() : dep === 'scribed' && recorder ? scribedHealth() : { dep, state: 'unknown', reason: null, since: now(), nextProbeAt: null, attempt: 0 })]
  const subscribers = new Set()
  let archiveAfter
  let approvalsEvent = () => {}
  const publish = event => {
    hub?.publish(event)
    for (const callback of subscribers) {
      try { callback(event) } catch {}
    }
    try { approvalsEvent(event) } catch {}
    // A prefs.changed that moves autoArchiveAfter sweeps once, after the event has reached every client.
    if (event.type === 'prefs.changed' && event.data?.prefs?.autoArchiveAfter !== archiveAfter) setImmediate(() => archiveSweep())
  }
  const projector = createProjector({ store, now, publish, locateTask: taskForCwd })
  link = createDeckdLink({ env, platform, connectDeckd, reconnectMs, random, now, store, projector, publish, timeoutMs: options.deckdTimeoutMs ?? 2000 })
  // M3 wiring (docs/plans/2026-10-02-deck-m3.md, Task 16): tiers, screen match, confirm labels, delivery, rules,
  // the approvals audit and popup actions.
  const maxSeq = () => Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq)
  /** Publish the events appended after `before`, or only those of one type and entity. */
  const publishSince = (before, type = null, entityId = null) => {
    for (const row of store.all('SELECT seq, at, type, entity_id, data FROM events WHERE seq > ? ORDER BY seq', before)) {
      if (type !== null && (row.type !== type || row.entity_id !== entityId)) continue
      publish({ seq: Number(row.seq), at: row.at, type: row.type, entityId: row.entity_id, data: JSON.parse(row.data) })
    }
  }
  /** Run a store change and publish the events it appended. */
  const commit = fn => {
    const before = maxSeq()
    const result = fn()
    publishSince(before)
    return result
  }
  /** One approvals audit row; a failing audit write never stops the change that caused it. */
  const audit = event => {
    try { recordAudit(store, { at: now(), ...event }) } catch {
      try { process.stderr.write('deck: audit.error\n') } catch {}
    }
  }
  /** The classifier over a stored permission request (null for one without its tool input). */
  const classifyRow = row => {
    if (!row.tool_name) return null
    let input = {}
    try { input = JSON.parse(row.detail) ?? {} } catch {}
    const session = store.get('SELECT cwd, repo_id FROM sessions WHERE id=?', row.session_id)
    return classifyHook({ tool_name: row.tool_name, tool_input: input, cwd: session?.cwd ?? null }, { repoRoot: session?.repo_id ?? undefined })
  }
  // The tiers store on <config>/tiers.json (07-approvals 4.1). A change raises the open requests' tiers and is
  // audited as tiers_loaded; a file that fails to parse or validate keeps the previous set and is audited as
  // tiers_rejected, once per distinct error.
  const tiersStore = createTiersStore({ file: path.join(paths.config, 'tiers.json'), watch: false })
  setActiveTiers(() => tiersStore.current())
  let tiersRejected = null
  const tiersAudit = () => {
    const status = tiersStore.status()
    if (status.ok) {
      tiersRejected = null
      audit({ kind: 'tiers_loaded', tiersSha256: tiersStore.sha256() })
      return
    }
    const key = `${status.line}:${status.message}`
    if (key === tiersRejected) return
    tiersRejected = key
    audit({ kind: 'tiers_rejected', summary: `line ${status.line ?? '?'}: ${status.message ?? ''}`, tiersSha256: tiersStore.sha256() })
  }
  tiersStore.onChange(() => {
    try { commit(() => raiseTiers(store, classifyRow, now())) } catch {}
  })
  let tiersWatcher = null
  let tiersTimer = null
  const reloadTiers = () => {
    tiersTimer = null
    if (stopped) return
    const before = tiersStore.sha256()
    const loaded = tiersStore.reload()
    if (!loaded || tiersStore.sha256() !== before) tiersAudit()
    else tiersRejected = null
  }
  try {
    tiersWatcher = fs.watch(paths.config, (kind, name) => {
      if (name !== null && name !== 'tiers.json') return
      clearTimeout(tiersTimer)
      tiersTimer = setTimeout(reloadTiers, options.tiersDebounceMs ?? 50)
    })
    tiersWatcher.on('error', () => {})
  } catch { tiersWatcher = null }
  tiersAudit()
  // The last parsed prompt of each PTY. A frame usually reaches the server before the PermissionRequest hook
  // that opens its request, so after each applied hook the PTY's last prompt is matched again.
  const lastPrompt = new Map()
  link.onParsed(event => {
    lastPrompt.set(event.ptyId, event.parsed.prompt)
    if (!event.sessionId) return
    try { commit(() => applyScreen(store, event.sessionId, event.parsed.prompt, now())) } catch {}
  })
  const reapplyScreen = envelope => {
    if (typeof envelope.ptyId !== 'string' || !lastPrompt.has(envelope.ptyId)) return
    const sessionId = store.get('SELECT id FROM sessions WHERE pty_id=? AND alive=1', envelope.ptyId)?.id
    if (!sessionId) return
    try { commit(() => applyScreen(store, sessionId, lastPrompt.get(envelope.ptyId), now())) } catch {}
  }
  // Rules and the suggestion threshold (`ruleSuggestAfter`), re-read on every prefs.changed.
  let threshold = ruleThreshold(store)
  const rules = createRules({ store, paths, publish, now })
  // Delivery: whatever a crash left in flight is recovered before the deliverer accepts an answer.
  recoverDeliveries(store, { now })
  const deliverer = createDeliverer({ store, link, publish, now, rules: { recordAllow, ruleThreshold: () => threshold }, ...options.deliver })
  // Confirm labels of Destructive requests, filled outside the hook transaction; close() waits for them.
  const labelWork = new Set()
  const scanWork = new Set()
  function preScanRequest(id) {
    const work = Promise.resolve().then(async () => {
      const row = store.get('SELECT * FROM requests WHERE id=?', id)
      if (!row || row.state !== 'open') return
      const session = store.get('SELECT * FROM sessions WHERE id=?', row.session_id)
      const result = await scanInstallRequest(row, session)
      if (!result || stopped) return
      commit(() => {
        const current = store.get('SELECT * FROM requests WHERE id=?', id)
        if (!current || current.state !== 'open') return
        let reasons = []; try { reasons = JSON.parse(current.reasons ?? '[]') } catch {}
        store.run('UPDATE requests SET tier=?,reasons=?,rule_pattern=NULL WHERE id=?', maxTier(current.tier, result.tier),
          JSON.stringify([...(Array.isArray(reasons) ? reasons : []).filter(reason => reason.entryId !== 'extension.scan'), result]), id)
        const view = requestView(store.get('SELECT * FROM requests WHERE id=?', id))
        store.appendEvent({ at: now(), type: 'request.updated', entityId: id, data: view })
      })
      if (store.get('SELECT tier FROM requests WHERE id=?', id)?.tier === 'destructive') fillLabel(id)
    }).catch(() => {}).finally(() => scanWork.delete(work))
    scanWork.add(work)
  }
  const fillLabel = id => {
    const before = maxSeq()
    const work = fillConfirmLabel(store, id, { countFor, tiers: tiersStore.current(), at: now() })
      .then(() => { if (!stopped) publishSince(before, 'request.updated', id) }, () => {})
      .finally(() => labelWork.delete(work))
    labelWork.add(work)
  }
  // Audit rows nothing else writes: `expired`, and `answered` via terminal for a request closed by a terminal
  // answer. The `answered` row goes through deliver.mjs `recordAnswered`, the one writer the deliverer and
  // `recover` use too, which appends it only when the request has none, so it is never written twice.
  const auditClosed = view => {
    const repoId = store.get('SELECT repo_id FROM sessions WHERE id=?', view.sessionId)?.repo_id ?? null
    const base = { requestId: view.id, sessionId: view.sessionId, repoId, tier: view.tier ?? null, reasons: view.reasons ?? [], summary: view.summary ?? null }
    if (view.state === 'expired') return audit({ kind: 'expired', ...base })
    const answer = view.answer
    if (view.state !== 'answered' || answer?.via !== 'terminal' || answer.pending || view.delivery === 'sending') return
    try { recordAnswered(store, { at: now(), ...base, via: 'terminal', choice: typeof answer.choice === 'string' ? answer.choice : null }) } catch {
      try { process.stderr.write('deck: audit.error\n') } catch {}
    }
  }
  approvalsEvent = event => {
    if (stopped) return
    if (event.type === 'request.opened' && event.data?.id) preScanRequest(event.data.id)
    if (event.type === 'request.opened' && event.data?.tier === 'destructive') fillLabel(event.data.id)
    if (event.type === 'request.closed' && event.data?.id) auditClosed(event.data)
    const prefs = event.type === 'prefs.changed' ? event.data?.prefs : null
    // A changed TurbidAssist config path is located and read again; a different result syncs the meetings.
    if (prefs) { configWatcher.reload(); void queueVault().catch(() => {}) }
    if (prefs && Object.hasOwn(prefs, 'ruleSuggestAfter') && prefs.ruleSuggestAfter !== threshold) {
      threshold = prefs.ruleSuggestAfter
      rules.setThreshold(threshold)
    }
  }
  // M4 meetings (docs/plans/2026-10-04-deck-m4.md, Task 11): the TurbidAssist config, the recorder (the 2 s scribed
  // poll that quiet mode and the scribed health row read), the post-processing watch and the meeting ask.
  const meetingsLog = options.meetingsLog ?? (() => {})
  let syncReason = null
  // The prefs, or null before the API exists or when reading them throws (an unreadable config.json), so the
  // recorder's view and the config watcher's locate get null rather than the exception.
  const currentPrefs = () => {
    try { return api?.preferences().prefs ?? null } catch { return null }
  }
  const syncMeetings = () => {
    if (stopped) return Promise.resolve()
    const view = recorder.view()
    return postWatch.sync({ recordingId: ['recording', 'stopping'].includes(view.state) ? view.meetingId : null }).then(result => {
      const reason = result.ok ? null : result.reason
      if (reason === syncReason) return
      syncReason = reason
      // Only the reason is logged: never a path, a tag or a title.
      if (reason === 'session_dir') { try { process.stderr.write('deck: meetings.sync_failed session_dir\n') } catch {} }
      meetingsLog({ event: 'meetings.sync', ok: result.ok, reason })
    }, () => {})
  }
  let sessionRoot = null
  const configWatcher = createConfigWatcher({
    locate: () => locateConfig({ pref: currentPrefs()?.turbidassistConfig ?? config.turbidassistConfig ?? null, home: paths.home }),
    read: file => readConfig(file, { home: paths.home }),
    onChange: next => {
      // The hook guard fails closed: a config that stops reading keeps the last good session_dir guarded, and only
      // a later config that reads ok replaces it.
      if (next?.ok) sessionRoot = realOrResolved(next.sessionDir)
      void syncMeetings()
    },
    debounceMs: options.configDebounceMs ?? 1000
  })
  const meetingConfig = () => configWatcher.current()
  if (meetingConfig()?.ok) sessionRoot = realOrResolved(meetingConfig().sessionDir)
  const scribedClient = options.scribedClient ?? (scribedUnsupported ? unavailableScribed(scribedUnsupported) : env.XDG_RUNTIME_DIR
    ? createScribedClient({ socketPath: path.join(env.XDG_RUNTIME_DIR, SOCKET_NAME), ...(options.scribedTimeouts ? { timeouts: options.scribedTimeouts } : {}) })
    : unavailableScribed('XDG_RUNTIME_DIR is not set'))
  const postWatch = createPostWatch({ store, config: meetingConfig, publish, now })
  recorder = options.scribedStatus ? standInRecorder(options.scribedStatus, now) : createRecorder({
    client: scribedClient, store, config: meetingConfig, prefs: () => currentPrefs() ?? {}, publish, now, log: meetingsLog,
    onStopped: id => postWatch.watch(id), ...(options.scribedPollMs ? { pollMs: options.scribedPollMs } : {})
  })
  const meetingAsk = createMeetingAsk({ client: scribedClient, recorder, publish, now, log: meetingsLog })
  // 11-meetings section 6, second guard: a hook from a process running inside session_dir is dropped before the
  // projector sees it, and only counted.
  let meetingHookDrops = 0
  const insideSessionDir = envelope => {
    const cwd = envelope?.hook?.cwd
    return sessionRoot !== null && typeof cwd === 'string' && cwd !== '' && !cwd.includes('\0') && insideDir(sessionRoot, realOrResolved(cwd))
  }
  const ingest = createIngestor({ now, onEvent: envelope => {
    if (insideSessionDir(envelope)) {
      meetingHookDrops++
      return
    }
    projector.applyHooks([envelope])
    noteHookVersion(envelope)
    reapplyScreen(envelope) }, onRejected: row => store.run('INSERT INTO rejected_events(received_at,via,reason,raw) VALUES(?,?,?,?)', row.receivedAt, row.via, row.reason, '') })
  const scanRoot = () => {
    const root = api?.preferences().prefs.scanRoot ?? config.scanRoot ?? '~/dev'
    return root.startsWith('~/') ? path.join(paths.home, root.slice(2)) : path.resolve(root)
  }
  const repoRoots = () => store.all('SELECT id FROM repos WHERE archived_at IS NULL').map(row => row.id)
  let rootsKey = ''
  let currentReader
  let runWatcher = null
  // A reader is rebuilt when the repo roots change; each new one gets the watch callback, so its run
  // directories keep triggering the compare-and-publish pass below.
  const reader = options.runReader ?? {
    async list() {
      const roots = repoRoots().sort()
      const key = JSON.stringify(roots)
      if (!currentReader || key !== rootsKey) {
        currentReader?.close()
        currentReader = createFleetmatesReader({ repoRoots: roots })
        if (runWatcher) currentReader.watch(runWatcher)
        rootsKey = key
      }
      return currentReader.list()
    },
    watch(callback) {
      runWatcher = callback
      currentReader?.watch(callback)
    },
    close() {
      runWatcher = null
      currentReader?.close()
    }
  }
  const processEnv = { ...env }
  for (const key of Object.keys(processEnv)) if (/TOKEN|SECRET|PASSWORD|AUTHORIZATION/i.test(key)) delete processEnv[key]
  const vaultPrefs = () => {
    const prefs = currentPrefs() ?? {}
    const value = prefs.vaultPath
    const vaultPath = typeof value === 'string' && value ? path.resolve(value === '~' ? paths.home : value.startsWith('~/') ? path.join(paths.home, value.slice(2)) : value) : null
    return { ...prefs, vaultPath }
  }
  const currentVault = () => {
    if (!vaultService) throw apiError(503, 'vault_unavailable')
    return vaultService
  }
  const dynamicVault = Object.fromEntries(['graph', 'list', 'readNote', 'note', 'search', 'lineBound', 'knownPaths', 'sessionMemory'].map(method => [method, (...args) => currentVault()[method](...args)]))
  const memory = {
    vault: dynamicVault, prefs: vaultPrefs,
    researchVault: {
      health: vaultHealth,
      supportsApproval: () => { const props = vaultClient?.toolSchema('vault_learn')?.properties; return props?.preview?.type === 'boolean' && props?.force_new?.type === 'boolean' && props?.expected_revision?.type === 'string' && props?.preview_time?.type === 'string' },
      identity: () => { const prefs = vaultPrefs(); return JSON.stringify({ vaultPath: prefs.vaultPath, command: prefs.vaultCommand, lang: prefs.lang, version: vaultHealth().version }) },
      call: (...args) => { if (!vaultClient) throw apiError(503, 'vault_unavailable'); return vaultClient.call(...args) }
    },
    ask: { ask: body => askService.ask(body), cancel: id => askService.cancel(id), isAsking: id => askService?.isAsking(id) ?? false },
    async captures(day) {
      await vaultWork
      // Explicit refreshes serialize with the timer, so two calls cannot race capture matching.
      const work = captureWork.catch(() => {}).then(() => refreshCaptures({ service: currentVault(), store, day, now }))
      captureWork = work
      return work
    }
  }
  function publishVault(next) {
    if (stopped) return
    if (next.state === vaultState.state && next.reason === vaultState.reason && JSON.stringify(next.capabilities) === JSON.stringify(vaultState.capabilities) && next.version === vaultState.version) return
    vaultState = { ...next }
    const at = now()
    const seq = Number(store.appendEvent({ at, type: 'health.changed', data: next }))
    publish({ seq, at, type: 'health.changed', data: next })
  }
  async function configureVault() {
    if (stopped) return
    const prefs = vaultPrefs()
    const key = JSON.stringify([prefs.vaultPath, prefs.vaultCommand, prefs.claudeCommand, prefs.lang])
    if (key === vaultKey) return
    vaultKey = key
    await captureWork.catch(() => {})
    await askService?.close()
    await vaultClient?.close()
    vaultClient = null
    vaultService = null
    if (prefs.vaultPath) {
      const client = createVaultClient({ command: prefs.vaultCommand, platform, env: {
        PATH: env.PATH, HOME: paths.home, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
        VAULT_PATH: prefs.vaultPath, VAULT_LANG: prefs.lang
      }, now, ...(options.vaultSpawn ? { spawn: options.vaultSpawn } : {}), ...(options.vaultTimers ? { timers: options.vaultTimers } : {}), log: options.vaultLog ?? (() => {}) })
      vaultClient = client
      vaultService = createVaultService({ client, store, now, log: options.vaultLog ?? (() => {}) })
      client.onHealth(next => { if (vaultClient === client) publishVault(next) })
      await client.start()
    } else publishVault({ dep: 'vault-mcp', state: 'down', reason: 'VAULT_PATH is not set', since: now(), nextProbeAt: null, attempt: 0, version: null, capabilities: [] })
    if (stopped) { await vaultClient?.close(); return }
    const engine = createAskEngine({ claudeCommand: prefs.claudeCommand, platform, stateDir: paths.state, env, now,
      ...(options.askSpawn ? { spawn: options.askSpawn } : {}), ...(options.askTimers ? { timers: options.askTimers } : {}), log: options.askLog ?? (() => {}) })
    askService = createAskService({ store, engine, vault: dynamicVault, health: vaultHealth, publish, now, prefs: vaultPrefs, log: options.askLog ?? (() => {}) })
    askService.reapOrphans()
  }
  function queueVault() {
    vaultWork = vaultWork.catch(() => {}).then(configureVault)
    return vaultWork
  }
  const run = (file, args) => command(file, args, processEnv)
  const hookCommand = deckHookCommand(process.execPath, paths.hook)
  // The hooks health row (owner decision 2026-10-01): computed now, rechecked after every rescan and hook
  // install, and published as health.changed only when its state or reason changes.
  // Task 23 (13-operations 9.4): an accepted envelope stamped older than this package (or unstamped) marks the
  // hooks outdated, shown as warn/hooks_outdated unless checkHooks reports hooks_missing or hook_script_missing.
  // A run of currentHookRun envelopes at the current version, or a successful POST /api/setup/hooks, clears it.
  let hooksOutdated = false
  let currentRun = 0
  const hooksRow = () => {
    const base = checkHooks(paths, hookCommand)
    return base.state === 'ok' && hooksOutdated ? { state: 'warn', reason: 'hooks_outdated' } : base
  }
  function noteHookVersion(envelope) {
    if (hookVersionOutdated(envelope.deckHookVersion, deckVersion)) {
      currentRun = 0
      if (hooksOutdated) return
      hooksOutdated = true
    } else {
      if (!hooksOutdated || ++currentRun < currentHookRun) return
      hooksOutdated = false
      currentRun = 0
    }
    recheckHooks()
  }
  hooksState = { dep: 'hooks', ...hooksRow(), since: now(), nextProbeAt: null, attempt: 0 }
  function recheckHooks() {
    const next = hooksRow()
    if (next.state === hooksState.state && next.reason === hooksState.reason) return
    const at = now()
    hooksState = { ...hooksState, ...next, since: at }
    publish({ seq: Number(store.appendEvent({ at, type: 'health.changed', data: { ...hooksState } })), at, type: 'health.changed', data: { ...hooksState } })
  }
  async function checks() { return doctor(paths, hookCommand, { run }) }
  // "Start deckd" goes through the platform's service manager (systemd, launchd or a detached process), made on first
  // use, since a platform without one throws. It probes deckd by connecting once; the web service is this process.
  let serviceManager = options.serviceManager ?? null
  const manager = () => serviceManager ??= createServiceManager({
    platform, paths, uid, env: processEnv, hubPath: fileURLToPath(new URL('..', import.meta.url)),
    run: async (file, args) => { const result = run(file, args)
      return { code: result.status, stdout: result.stdout, stderr: result.stderr } },
    probe: async service => {
      if (service !== 'deckd') return true
      try { (await connectDeckd({ runtimeDir: runtimeBase({ env, platform, uid }), kind: 'server' })).close()
        return true } catch { return false }
    }
  })
  const services = {
    checks,
    async installHooks() {
      try {
        const current = readSettings(paths.settings)
        const backupPath = writeSettings(paths.settings, current, transformHooks(current.value, hookCommand))
        hooksOutdated = false
        currentRun = 0
        return { check: (await checks()).find(check => check.id === 'hooks'), backupPath }
      } catch (error) { throw apiError(error instanceof SyntaxError ? 422 : 500, error instanceof SyntaxError ? 'validation_failed' : 'settings_io_failed') }
      finally { recheckHooks() }
    },
    async startDependency(dep) {
      if (dep === 'vault-mcp') { await queueVault(); return vaultClient ? vaultClient.retry() : vaultHealth() }
      if (dep === 'scribed') {
        if (scribedUnsupported) throw apiError(503, 'scribed_unavailable', { reason: scribedUnsupported })
        // OPS-O1: the decided systemd-run command, with the token-free environment, then an immediate probe.
        await startScribed({ scribedCommand: api.preferences().prefs.scribedCommand, env: processEnv, probe: () => scribedClient.status(),
          ...(options.scribedExecFile ? { execFile: options.scribedExecFile } : {}) })
        return recorder.probeNow()
      }
      try { await manager().start('deckd') } catch { throw apiError(502, 'dependency_start_failed') }
      return link.retry()
    },
    async retryDependency(dep) {
      if (dep === 'vault-mcp') { await queueVault(); return vaultClient ? vaultClient.retry() : vaultHealth() }
      if (dep === 'deckd') return link.retry()
      if (dep === 'scribed') return recorder.probeNow()
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
    // Opens one resolved, checked absolute path (open.mjs) with the token-free environment.
    open(file) { return openPath(file, { platform, env: processEnv }) },
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
  api = createApi({ store, projector, paths, env, now, publish, services, link, runReader: reader, health, memory, meetings: { config: meetingConfig, recorder, ask: meetingAsk },
    approvals: { deliverer, rules, threshold: () => threshold, tiersStatus: () => tiersStore.status(),
      ruleOffers: () => ruleOffers(store, { threshold, tiers: tiersStore.current() }), ...(options.diff ? { diff: options.diff } : {}) } })
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
  const server = http.createServer(createRouter({ api: api.route, staticDir: options.staticDir ?? builtSpa, getToken: refreshToken, getPort: () => boundPort,
    getPublicOrigin: () => publicOrigin, remote }))
  hub = createWsHub({ server, store, epoch, link, snapshot: api.snapshot, getToken: refreshToken, getPort: () => boundPort, getPublicOrigin: () => publicOrigin, now, heartbeatMs: options.heartbeatMs, helloTimeoutMs: options.helloTimeoutMs })
  // Deck tabs: WebSocket upgrades that pass the hub's own checks, until their socket closes. A popup "Open"
  // navigates a connected tab and otherwise opens the deck in the browser.
  const tabs = new Set()
  server.on('upgrade', (req, socket) => {
    try { if (req.url !== '/api/ws' || authorize(req, { port: boundPort, token: refreshToken(), upgrade: true, publicOrigin })) return } catch { return }
    tabs.add(socket)
    socket.once('close', () => tabs.delete(socket))
  })
  /** Open one session (popup "Open", 04-integrations 5): `ui.navigate` to a connected tab, else the fragment URL. */
  function openSession(sessionId) {
    const to = `/s/${encodeURIComponent(sessionId)}`
    if (tabs.size) {
      publish({ type: 'ui.navigate', at: now(), data: { path: to } })
      return Promise.resolve()
    }
    // The token travels in the fragment of a private bootstrap file (0600, in the state directory made 0700 again
    // right before the write, so a directory loosened after start cannot expose it), as `fleetmates-deck open`
    // does, never in argv; the opener gets the environment without the deck token.
    const url = `http://127.0.0.1:${boundPort}/#token=${currentToken}&to=${encodeURIComponent(to)}`
    const bootstrap = path.join(paths.state, 'open.html')
    const temp = path.join(paths.state, `.open-${process.pid}-${Date.now()}.tmp`)
    try {
      privateDir(paths.state, owner)
      fs.writeFileSync(temp, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>location.replace(${JSON.stringify(url)})</script>\n`, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temp, bootstrap)
    } catch { return Promise.resolve() } finally { try { fs.unlinkSync(temp) } catch {} }
    return Promise.resolve().then(() => (options.openBrowser ?? openInBrowser)(bootstrap, { env: processEnv, platform })).catch(() => {})
  }
  /**
   * A popup action (Task 5): `allow` answers the single Safe request through the deliverer, anything else opens.
   * An allow the deliverer refuses at click time (the tier rose, the prompt left the screen) opens the session
   * instead (state-machines 2.7 row 6).
   */
  function popupAction({ key, requestIds, sessionId }) {
    if (key === 'allow' && requestIds.length === 1) {
      deliverer.answer(requestIds[0], { choice: 'allow' }, { via: 'popup' }).catch(() => { if (!stopped) openSession(sessionId) })
      return
    }
    openSession(sessionId)
  }
  let hooks
  let spool
  let runPass = () => {}
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
  // The auto-archive sweep (docs/plans/2026-10-02-deck-archive.md, Task 2): archives, as 'auto', every finished,
  // unarchived session without unreviewed changes whose coalesce(ended_at, state_since) is autoArchiveAfter hours
  // old or more. The projector commit runs only when there is a candidate, so an idle sweep appends no event.
  function archiveSweep() {
    if (stopped) return
    try {
      archiveAfter = api.preferences().prefs.autoArchiveAfter
      if (autoArchiveCandidates(store, { at: now(), afterHours: archiveAfter }).length) projector.autoArchive(archiveAfter)
    } catch {}
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
    deliverer.close()
    clearTimeout(tiersTimer)
    tiersWatcher?.close()
    tiersStore.close()
    setActiveTiers(null)
    link.close()
    if (retentionTimeout !== null) retentionTimer.clear(retentionTimeout)
    retentionTimeout = null
    for (const timer of timers) clearInterval(timer)
    await vaultWork.catch(() => {})
    await captureWork.catch(() => {})
    await askService?.close()
    await vaultClient?.close()
    meetingAsk.close()
    recorder.close()
    postWatch.close()
    configWatcher.close()
    await notificationWork.catch(() => {})
    notifications?.close()
    await Promise.allSettled([...labelWork, ...scanWork])
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
    privateDir(paths.spool, owner)
    await queueVault()
    if (['ok', 'degraded'].includes(vaultHealth().state)) await memory.captures(localDate(now()).day).catch(() => {})
    const captureTimer = setInterval(() => {
      if (stopped || captureBusy || !['ok', 'degraded'].includes(vaultHealth().state)) return
      captureBusy = true
      memory.captures(localDate(now()).day).catch(() => {}).finally(() => { captureBusy = false })
    }, options.captureRefreshMs ?? 60000)
    captureTimer.unref()
    timers.push(captureTimer)
    retention()
    scheduleRetention()
    archiveSweep()
    const sweep = setInterval(archiveSweep, options.archiveSweepMs ?? 600_000)
    sweep.unref()
    timers.push(sweep)
    // The first probe settles the recorder before the history sync, so the session being recorded is listed as such.
    if (options.scribedStatus) await options.scribedStatus.start?.()
    await recorder.probeNow().catch(() => {})
    await syncMeetings()
    if (options.notifications !== false) {
      const [{ createNotifier }, { createNotificationMachine }] = await Promise.all([
        import('./adapters/notify.mjs'), import('./machines/notification.mjs')
      ])
      notifications = createNotificationMachine({ store, now, publish, onAction: popupAction,
        notifier: options.notifier ?? createNotifier({ platform, env: processEnv }), recording: () => recorder.isRecording() })
    }
    spool = await startSpoolDrain({ dir: paths.spool, ingest })
    // The hook endpoint lives under runtimeBase: XDG_RUNTIME_DIR when it is set, else the platform's fallback base. On
    // linux that fallback is shared by every deck server of this user, so when another one already listens there this
    // server leaves it alone and takes hooks from the spool only.
    try { hooks = await startHookSocket({ runtimeDir: runtimeBase({ env, platform, uid }), ingest, platform, uid }) } catch (error) {
      if (error.code !== 'EADDRINUSE' || env.XDG_RUNTIME_DIR) throw error
      try { process.stderr.write('deck: hooks.endpoint_in_use\n') } catch {}
    }
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
    // run.updated (05-api 3.4): re-read the runs and publish each run whose JSON changed since the previous
    // read. The pass runs whenever the reader reports a changed run directory (debounced by the reader) and
    // every runPollMs as the fallback. The reader watches each run directory any list() has found, so listen()
    // starts one priming pass: it lists the runs, which arms the watchers, and records each run's JSON as the
    // baseline without publishing. listen() does not wait for it, and a failing list only leaves the baseline
    // empty, so the next pass publishes every run once. Passes never overlap: a request during a pass (the
    // priming one included) reruns it once that pass ends, and the shared comparison means a watch event and
    // the poll never publish the same change twice.
    initializeLedgerTimeline(store)
    const runJson = new Map()
    let runBusy = false
    let runAgain = false
    runPass = (prime = false) => {
      if (stopped) return
      if (runBusy) { if (!prime) runAgain = true
        return }
      runBusy = true
      runAgain = false
      Promise.resolve().then(() => reader.list()).then(api.withLeads).then(list => {
        if (stopped) return
        for (const row of list) {
          syncLedgerTimeline(store, row, now())
          const key = JSON.stringify([row.repoId, row.runId])
          const text = JSON.stringify(row)
          if (runJson.get(key) === text) continue
          runJson.set(key, text)
          if (prime) continue
          const at = now()
          publish({ seq: Number(store.appendEvent({ at, type: 'run.updated', entityId: row.runId, data: row })), at, type: 'run.updated', data: row })
        }
      }).catch(() => {}).finally(() => { runBusy = false
        if (runAgain) runPass() })
    }
    reader.watch?.(() => runPass())
    const runPoll = setInterval(() => runPass(), options.runPollMs ?? 60_000)
    const rotation = setInterval(() => { try { refreshToken() } catch {} }, tokenPollMs)
    const tick = setInterval(() => { projector.tick(now()) }, 5000)
    for (const timer of [runPoll, rotation, tick]) { timer.unref()
      timers.push(timer) }
  } catch (error) { await close()
    throw error }
  return {
    server, store, projector, ingest, epoch, publish, link, notifications, recording: recorder, recorder, snapshot: api.snapshot, preferences: api.preferences,
    /** Hook envelopes dropped because their `cwd` is inside the configured `session_dir`. */
    meetingHookDrops: () => meetingHookDrops,
    /** The hook endpoint this server listens on, or null when it takes hooks from the spool only. */
    hookEndpoint: () => hooks?.path ?? null,
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
      runPass(true)
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
/**
 * The server entrypoint's own arguments. Only `--public-origin <url>` for now, for an operator who runs the server
 * by hand; under systemd the drop-in sets `DECK_PUBLIC_ORIGIN` and `fleetmates-deck remote-access` writes
 * `publicOrigin` into `config.json`.
 * @param {string[]} argv
 * @returns {{ publicOrigin?: string }}
 */
export function parseServerArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== '--public-origin' || typeof argv[i + 1] !== 'string') throw Error('usage: server/main.mjs [--public-origin <https://host>]')
    options.publicOrigin = argv[i + 1]
  }
  return options
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startDeckServer(parseServerArgs(process.argv.slice(2))).then(deck => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { deck.close().catch(() => { process.exitCode = 1 }) })
  }).catch(() => { process.stderr.write('deck server startup failed\n')
    process.exitCode = 1 })
}
