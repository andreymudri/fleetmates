import fs from 'node:fs'
import path from 'node:path'
import { apiError } from './router.mjs'
import { parseOpenRequest, readRunPlan, resolveMeetingNote, resolvePostmeetLog, resolveRunPlan } from './open.mjs'
import { MeetingFileError, SESSION_ID, foldText, listSessions, logTail, postState, readTranscript, searchTranscripts, speakers as speakerCount } from '../meetings/history.mjs'
import { findNote, parseNote, readNote } from '../meetings/note.mjs'
import { addPin, dismissItem, dismissed as dismissedKeys, getMeeting, listMeetings, pins as meetingPins, removePin, undismissItem } from '../meetings/store.mjs'
import { persistSessionSummary } from '../machines/session.mjs'
import { projectCounts } from '../machines/counts.mjs'
import { createLauncher, headBranch, SCROLLBACK_LINES, SCROLLBACK_LINES_MAX } from '../launch/launch.mjs'
import { DiffError, sessionDiff } from '../adapters/git-diff.mjs'
import { gitRead } from '../adapters/git-read.mjs'
const deckVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const defaults = {
  port: 47800, scanRoot: '~/dev', lang: 'en', staleMinutes: 20, claudeCommand: 'claude',
  vaultPath: null, vaultCommand: ['npx', '-y', '@andreymudri/vault-mcp'], obsidianVaultName: null,
  turbidassistConfig: null, scribedCommand: 'scribed', researchWorkspace: '~/.local/share/fleetmates-deck/research/',
  ruleSuggestAfter: 5, textSize: 14, motion: 'system', terminalScreenReader: false, bell: true,
  renotifyAfter: 10, notifyDone: true, quietInMeetings: true, notifyCrash: true, firstRunCompletedAt: null,
  autoArchiveAfter: 24
}
const configKeys = new Set(['port', 'scanRoot', 'lang', 'staleMinutes', 'claudeCommand', 'vaultPath', 'vaultCommand', 'obsidianVaultName', 'turbidassistConfig', 'scribedCommand', 'researchWorkspace'])
const envKeys = { port: 'DECK_PORT', lang: 'DECK_LANG', vaultPath: 'VAULT_PATH' }
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]))
// POST routes that take a JSON body; every other POST with a body is refused before routing.
const postBodyRoutes = new Set(['open', 'sessions', 'requests/answer-batch', 'rules', 'rules/suggestions/dismiss', 'meetings/start', 'ask'])
/** Whether a POST to these segments may carry a body: the routes above, the request answer and follow-up, and meeting pins. */
const takesBody = (route, s) => postBodyRoutes.has(route) || (s[1] === 'requests' && s.length === 4 && ['answer', 'followup'].includes(s[3])) ||
  (s[1] === 'meetings' && s.length === 4 && s[3] === 'pins')
/** The keys each M3 body may hold (05-api 2.4 and 2.5); any other key is `validation_failed`. */
const bodyKeys = {
  answer: ['choice', 'optionKey', 'text', 'confirm'],
  batch: ['ids', 'choice'],
  followup: ['text'],
  rule: ['repoKey', 'pattern', 'source'],
  dismiss: ['repoKey', 'pattern'],
  start: ['tag'],
  pins: ['t'],
  ask: ['text', 'scope', 'threadId']
}
/**
 * HTTP statuses of the answer and rule codes, as 05-api section 4 lists them, with the answer refusals the
 * M3 plan (Task 16) puts at 409. Codes not listed keep the status they were raised with.
 */
const codeStatus = {
  confirm_required: 409, tier_forbids: 409, batch_not_safe: 409, not_on_screen: 409, answer_in_flight: 409, request_closed: 409,
  read_only_session: 409, deckd_outdated: 409, typing_in_terminal: 409, followup_window_closed: 409, options_unreadable: 409,
  invalid_pattern: 422, destructive_rule: 422, rule_exists: 409, settings_changed: 409, settings_io_failed: 500,
  unknown_tag: 422, scribed_refused: 409, scribed_unavailable: 503, not_recording: 409, ask_in_progress: 409, dependency_start_failed: 502
}
/** Codes whose request may succeed unchanged later (05-api section 4 `retryable`). */
const retryableCodes = new Set(['deckd_unavailable', 'typing_in_terminal', 'settings_changed', 'scribed_unavailable'])
function onlyKeys(body, keys) {
  const unknown = Object.keys(body).filter(key => !keys.includes(key))
  if (unknown.length) throw apiError(422, 'validation_failed', { fields: unknown })
}
const hats = ['none', 'cap', 'bandana']
const validStates = ['starting', 'running', 'needs_approval', 'asked_you', 'done', 'stale', 'idle', 'reviewed', 'crashed', 'ended']
function integer(query, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (!query.has(name)) return fallback
  const value = query.get(name)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw apiError(422, 'validation_failed', { fields: [name] })
  return Number(value)
}
/** No file system call accepts a path with NUL in it; refuse it as bad input (400) before one throws a 500. */
function filePath(value, field) {
  if (typeof value === 'string' && value.includes('\0')) throw apiError(400, 'validation_failed', { fields: [field] })
  return value
}
function validatePref(key, value) {
  if (!Object.hasOwn(defaults, key) || ['staleMinutes', 'firstRunCompletedAt'].includes(key)) return false
  if (typeof defaults[key] === 'boolean') return typeof value === 'boolean'
  if (key === 'textSize') return [13, 14, 15, 16].includes(value)
  if (key === 'ruleSuggestAfter') return [3, 5, null].includes(value)
  if (key === 'renotifyAfter') return [5, 10, 20, null].includes(value)
  // Hours after which a finished session is auto-archived; null is Never.
  if (key === 'autoArchiveAfter') return [6, 12, 24, 72, 168, null].includes(value)
  if (key === 'motion') return ['system', 'reduce'].includes(value)
  if (key === 'lang') return ['en', 'pt'].includes(value)
  if (key === 'port') return Number.isInteger(value) && value > 0 && value <= 65535
  if (key === 'vaultCommand') return Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string' && part.length && !part.includes('\0'))
  return (value === null && defaults[key] === null) || typeof value === 'string' && value.length > 0 && !value.includes('\0')
}
/**
 * Build the REST reads and guarded writes over the canonical projector. `approvals` carries the M3 services
 * (Task 16): `deliverer` (approvals/deliver.mjs), `rules` (approvals/rules.mjs `createRules`), `threshold()`
 * (the current `ruleSuggestAfter`), `tiersStatus()` (the tiers store's status), `ruleOffers()` (the
 * snapshot's open offers) and optionally `diff` (git-diff `sessionDiff`). Without it the answer and rule
 * routes answer 404 and the snapshot carries no offers. `meetings` carries the M4 services (Task 11): `config()` (the
 * Task 4 config result), `recorder` (meetings/recorder.mjs) and `ask` (meetings/ask.mjs); without it the meeting routes
 * answer 404 and the snapshot's recorder comes from `recorder()`.
 */
export function createApi({ store, projector, paths, env = {}, now = Date.now, publish, services, link, runReader, health, recorder = () => ({ state: 'idle' }), approvals = null, meetings = null }) {
  const configFile = path.join(paths.config, 'config.json')
  function preferences() {
    let config = {}
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw apiError(500, 'settings_io_failed') }
    const db = Object.fromEntries(store.all('SELECT key,value FROM prefs').map(row => [row.key, JSON.parse(row.value)]))
    const prefs = {}
    const sources = {}
    for (const [key, value] of Object.entries(defaults)) {
      const variable = envKeys[key]
      if (variable && env[variable] !== undefined) { prefs[key] = key === 'port' ? Number(env[variable]) : env[variable]
        sources[key] = 'env' }
      else if (Object.hasOwn(config, key)) { prefs[key] = config[key]
        sources[key] = 'config' }
      else if (Object.hasOwn(db, key)) { prefs[key] = db[key]
        sources[key] = 'db' }
      else { prefs[key] = value
        sources[key] = 'default' }
    }
    return { prefs, sources }
  }
  const launcher = createLauncher({ store, projector, link, publish, now, preferences })
  function event(type, data, entityId = null) {
    const at = now()
    const seq = Number(store.appendEvent({ at, type, entityId, data }))
    publish({ seq, at, type, data })
  }
  function repos(includeArchived = false) {
    const lastSession = new Map(store.all('SELECT repo_id,MAX(started_at) AS at FROM sessions GROUP BY repo_id').map(row => [row.repo_id, row.at]))
    return store.all(`SELECT * FROM repos${includeArchived ? '' : ' WHERE archived_at IS NULL'} ORDER BY name`).map(row => ({
      id: row.id, repoId: row.id, repoKey: row.name, name: row.name, crew: { slot: row.crew_slot, slotShared: !!row.crew_slot_shared, seed: row.crew_seed, hat: row.hat },
      firstSeenAt: row.first_seen_at, missingSince: row.missing_since, archivedAt: row.archived_at,
      lastSessionAt: lastSession.get(row.id) ?? null, branch: headBranch(row.id)
    }))
  }
  function resolveRepo(query, key) {
    const id = query.get('repoId')
    const name = key ?? query.get('repoKey')
    if (!id && !name) return null
    const row = id ? store.get('SELECT id FROM repos WHERE id=?', id) : store.get('SELECT id FROM repos WHERE name=?', name)
    if (!row) throw apiError(404, 'not_found')
    return row.id
  }
  function session(id) {
    const found = projector.snapshot().sessions.find(row => row.id === id)
    if (!found) throw apiError(404, 'not_found')
    return found
  }
  function steps(id, query) {
    session(id)
    const task = query.get('taskId')
    const rows = store.all(`SELECT * FROM session_steps WHERE session_id=?${task ? ' AND task_id=?' : ''} ORDER BY seq DESC LIMIT ?`, id, ...(task ? [task] : []), integer(query, 'limit', 50, 200))
    return rows.reverse().map(camel)
  }
  function activeRun(run) {
    return !!run.leadSessionId && projector.snapshot().sessions.some(row => row.id === run.leadSessionId && row.alive) || run.tasks?.some(task => !['done', 'skipped', 'cancelled'].includes(task.state))
  }
  /** Fill each run's `leadSessionId` from the `runs` table, where the run join records the lead. */
  function withLeads(list) {
    const leads = new Map(store.all('SELECT repo_id,run_id,lead_session_id FROM runs WHERE lead_session_id IS NOT NULL').map(row => [JSON.stringify([row.repo_id, row.run_id]), row.lead_session_id]))
    return list.map(run => ({ ...run, leadSessionId: leads.get(JSON.stringify([run.repoId, run.runId])) ?? run.leadSessionId ?? null }))
  }
  async function runs(query) {
    const id = resolveRepo(query)
    return withLeads(await runReader.list()).filter(run => (!id || run.repoId === id) && (query.get('active') !== '1' || activeRun(run)))
  }
  async function snapshot() {
    const projection = projector.snapshot()
    const prefs = preferences().prefs
    return {
      seq: projection.seq,
      data: { sessions: projection.sessions.filter(row => row.state !== 'ended' || row.endedAt >= now() - 86_400_000), requests: projection.requests.filter(row => row.state === 'open'),
        runs: withLeads(await runReader.list()).filter(activeRun), repos: repos(), counts: projection.counts, order: projection.home.order,
        recap: { reviewed: store.get('SELECT COUNT(*) AS n FROM sessions WHERE reviewed_at IS NOT NULL').n },
        ruleOffers: approvals?.ruleOffers() ?? [], research: [], recorder: meetings ? recorderView() : recorder(), health: health(), prefs, setup: { firstRunCompletedAt: prefs.firstRunCompletedAt } }
    }
  }
  /** The M4 meeting services, or 404 for a server built without them. */
  function mtg() {
    if (!meetings) throw apiError(404, 'not_found')
    return meetings
  }
  /** The config result when it read ok, else null. */
  function meetingConfig() {
    const config = mtg().config()
    return config?.ok ? config : null
  }
  /** The recorder view; confidentiality only rises, so a stored confidential row marks the view confidential. */
  function recorderView(view = mtg().recorder.view()) {
    if (view.meetingId && !view.confidential && getMeeting(store, view.meetingId)?.confidential) return { ...view, confidential: true }
    return view
  }
  const publishStored = events => { for (const row of events) publish({ seq: row.seq, at: row.at, type: row.type, entityId: row.entityId, data: row.data }) }
  /** The stored meeting `id`, or 404. */
  function meetingRow(id) {
    const row = typeof id === 'string' && SESSION_ID.test(id) ? getMeeting(store, id) : null
    if (!row) throw apiError(404, 'not_found')
    return row
  }
  /** The vault-relative note path of a meeting: the stored one, else looked up on disk once it is synthesized. */
  async function notePathOf(config, meeting) {
    if (meeting.notePath) return meeting.notePath
    if (meeting.state !== 'synthesized' || !config.vaultPath || !config.meetingsFolder) return null
    try { return await findNote({ vaultPath: config.vaultPath, meetingsFolder: config.meetingsFolder, id: meeting.id, tag: meeting.tag, date: meeting.id.slice(0, 10) }) } catch { return null }
  }
  /** The parsed meeting note, read from disk on each call, or null. */
  async function noteOf(config, meeting) {
    if (!config?.vaultPath) return null
    const notePath = await notePathOf(config, meeting)
    if (!notePath) return null
    try {
      const text = await readNote({ vaultPath: config.vaultPath, notePath })
      return text === null ? null : parseNote(text)
    } catch { return null }
  }
  /** The deck-derived `stuck` flag of state-machines 6.4, false while recording, synthesized or without a config. */
  async function stuckOf(config, meeting) {
    if (!config || ['synthesized', 'recording'].includes(meeting.state)) return false
    try { return (await postState(config.sessionDir, meeting.id, { now: now() })).stuck } catch { return false }
  }
  const refused = error => {
    if (error instanceof MeetingFileError) throw apiError(403, 'path_not_allowed')
    throw error
  }
  /** `GET /api/meetings`: the stored rows with title, open action item count, stuck and interrupted read per request. */
  async function meetingList(q) {
    const raw = mtg().config()
    const config = raw?.ok ? raw : null
    const limit = integer(q, 'limit', 50, 500)
    const before = q.has('before') ? integer(q, 'before', null) : null
    const view = recorderView()
    const interrupted = new Map()
    if (config) {
      try { for (const entry of await listSessions(config.sessionDir, { now: now(), recordingId: view.meetingId })) interrupted.set(entry.id, entry.interrupted) } catch {}
    }
    const items = await Promise.all(listMeetings(store, { before, limit }).map(async row => {
      const note = await noteOf(config, row)
      const gone = new Set(dismissedKeys(store, row.id))
      const actionItemCount = note ? note.actionItems.filter(item => !gone.has(item.key)).length : null
      return { ...row, title: note?.title ?? null, actionItemCount, stuck: await stuckOf(config, row), interrupted: interrupted.get(row.id) === true }
    }))
    const configError = config ? null : { code: raw?.error?.code ?? 'not_found', line: raw?.error?.line ?? null, message: raw?.error?.message ?? 'no TurbidAssist config located', path: raw?.path ?? null }
    return { meetings: items, recorder: view, tags: config ? config.tags : [], model: config?.batchModel ?? null, configError }
  }
  /** `GET /api/meetings/:id`: the meeting, its note with dismissals, pins, speakers and model, read per request. */
  async function meetingDetail(id) {
    const row = meetingRow(id)
    const config = meetingConfig()
    const note = await noteOf(config, row)
    const gone = new Set(dismissedKeys(store, row.id))
    let speakers = null
    let logAt = null
    if (config) {
      try {
        const transcript = await readTranscript(config.sessionDir, row.id)
        if (transcript) speakers = speakerCount(transcript.lines)
      } catch {}
      try { logAt = fs.lstatSync(path.join(config.sessionDir, row.id, 'postmeet.log')).mtimeMs } catch {}
    }
    const data = {
      meeting: { ...row, title: note?.title ?? null, stuck: await stuckOf(config, row), logAt },
      note: note ? { title: note.title, summary: note.summary, decisions: note.decisions, actionItems: note.actionItems.map(item => ({ ...item, dismissed: gone.has(item.key) })) } : null,
      pins: meetingPins(store, row.id), speakers, model: config?.batchModel ?? null
    }
    const view = recorderView()
    if (view.state === 'recording' && view.meetingId === row.id) {
      try { data.asks = await mtg().ask.history(row.id) } catch {}
    }
    return data
  }
  /** `GET /api/meetings/:id/transcript`: the recorder ring for the meeting being recorded, else the disk, never cached. */
  async function meetingTranscript(id) {
    const row = meetingRow(id)
    const view = recorderView()
    if (view.meetingId === row.id && ['recording', 'stopping'].includes(view.state)) return { source: 'live', lines: mtg().recorder.ring(row.id) }
    const config = meetingConfig()
    if (!config) throw apiError(404, 'not_found')
    const transcript = await readTranscript(config.sessionDir, row.id).catch(refused)
    if (!transcript) throw apiError(404, 'not_found')
    return { source: transcript.source, lines: transcript.lines }
  }
  /** `GET /api/meetings/:id/log`: the last `lines` (1 to 1000, default 200) lines of `postmeet.log`. */
  async function meetingLog(id, q) {
    const row = meetingRow(id)
    const lines = integer(q, 'lines', 200, 1000)
    const config = meetingConfig()
    const text = config ? await logTail(config.sessionDir, row.id, lines).catch(refused) : null
    if (text === null) throw apiError(404, 'not_found')
    return { text }
  }
  /** `GET /api/meetings/search`: an on-demand scan of every session's transcript, confidential ones included, never cached. */
  async function meetingSearch(q) {
    mtg()
    const text = q.get('q') ?? ''
    if (foldText(text.trim()).folded.length < 2) throw apiError(422, 'validation_failed', { fields: ['q'] })
    const config = meetingConfig()
    if (!config) return { hits: [], meetingCount: 0, partial: false }
    let sessions = []
    try { sessions = await listSessions(config.sessionDir, { now: now(), recordingId: recorderView().meetingId }) } catch {}
    return searchTranscripts(sessions, text)
  }
  /** `POST /api/meetings/:id/pins`: only for the meeting being recorded; a pin within 2 s of another returns that one. */
  function meetingPin(id, body) {
    onlyKeys(body, bodyKeys.pins)
    const view = recorderView()
    if (view.state !== 'recording' || view.meetingId !== id) {
      meetingRow(id)
      throw apiError(409, 'not_recording')
    }
    if (body.t !== undefined && !(typeof body.t === 'number' && Number.isFinite(body.t) && body.t >= 0)) throw apiError(422, 'validation_failed', { fields: ['t'] })
    const t = body.t ?? view.elapsedS
    const ring = mtg().recorder.ring(id)
    const line = ring.find(entry => entry.t0 === t) ?? ring.at(-1) ?? null
    const result = addPin(store, id, { t, label: view.confidential ? null : line?.text ?? null, at: now() })
    if (!result) throw apiError(404, 'not_found')
    publishStored(result.events)
    return { status: result.created ? 201 : 200, data: { pin: result.pin } }
  }
  /** `POST /api/ask` with `scope: 'meeting:<id>'`, the only scope in M4; the answer streams as ephemeral events. */
  function meetingAsk(body) {
    onlyKeys(body, bodyKeys.ask)
    const fields = []
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.includes('\0')) fields.push('text')
    const scope = typeof body.scope === 'string' ? /^meeting:(.+)$/s.exec(body.scope) : null
    if (!scope) fields.push('scope')
    if (body.threadId !== undefined && (typeof body.threadId !== 'string' || !body.threadId)) fields.push('threadId')
    if (fields.length) throw apiError(422, 'validation_failed', { fields })
    return { status: 202, data: mtg().ask.ask(scope[1], body.text) }
  }
  /** `POST /api/open` for the meeting kinds (08-security 4.9); without a readable config the kinds are not available. */
  async function openMeeting({ kind, ref }) {
    const config = meetings ? meetingConfig() : null
    if (!config) throw apiError(422, 'validation_failed', { fields: ['kind'], reason: 'kind_not_available' })
    const row = meetingRow(ref)
    if (kind === 'postmeetLog') return services.open(await resolvePostmeetLog(config.sessionDir, row.id))
    const notePath = config.vaultPath ? await notePathOf(config, row) : null
    if (!notePath) throw apiError(404, 'not_found')
    return services.open(await resolveMeetingNote({ vaultPath: config.vaultPath, notePath, vaultName: preferences().prefs.obsidianVaultName }))
  }
  /** The M3 services, or 404 for a server built without them. */
  function m3() {
    if (!approvals) throw apiError(404, 'not_found')
    return approvals
  }
  /**
   * Whether git tracks the repo's `.claude/settings.local.json`, asked as `POST /api/rules` asks it (rules.mjs
   * `writeRule`): `git ls-files --error-unmatch` through the read-only git helper in the repo's real path.
   */
  async function settingsTracked(repoId) {
    let root = repoId
    try { root = fs.realpathSync(repoId) } catch {}
    return (approvals?.gitRead ?? gitRead)(root, ['ls-files', '--error-unmatch', '.claude/settings.local.json']).then(result => result?.code === 0, () => false)
  }
  /**
   * `GET /api/rules` (05-api 2.5): every repo that is not archived, or the one `repoKey` names. Each rule carries
   * `tracked`, so Settings can show the tracked-file note.
   */
  async function rulesBody(query) {
    const { rules, threshold, tiersStatus } = m3()
    const id = resolveRepo(query)
    const status = tiersStatus()
    const listed = repos().filter(repo => !id || repo.id === id).map(repo => ({ repoKey: repo.name, ...rules.listRules(repo.id) }))
    const tracked = await Promise.all(listed.map(repo => settingsTracked(repo.repoId)))
    return {
      threshold: threshold(),
      tiersError: status.ok ? null : { line: status.line, message: status.message },
      repos: listed.map((repo, index) => ({ ...repo, rules: repo.rules.map(rule => ({ ...rule, tracked: tracked[index] })) }))
    }
  }
  /** The repo and pattern of a rule body: both non-empty strings, the repo known. */
  function ruleTarget(body) {
    const fields = ['repoKey', 'pattern'].filter(key => typeof body[key] !== 'string' || !body[key] || body[key].includes('\0'))
    if (fields.length) throw apiError(422, 'validation_failed', { fields })
    return { repoId: resolveRepo(new URLSearchParams(), body.repoKey), pattern: body.pattern }
  }
  async function route({ method, segments: s, query: q, body }) {
    const route = s.slice(1).join('/')
    const ok = data => ({ data })
    if (!['GET', 'PATCH', 'POST', 'DELETE'].includes(method)) throw apiError(404, 'not_found')
    if (method === 'GET') {
      if (route === 'version') return ok({ apiVersion: 1, deckVersion, build: 'm3' })
      if (route === 'health') return ok({ deps: health() })
      if (route === 'prefs') return ok(preferences())
      if (route === 'repos') return ok({ repos: repos(q.get('archived') === '1') })
      if (route === 'setup/checks') {
        const ids = ['claude', 'hooks', 'deckd', 'vault', 'scribed', 'notify']
        const checks = ids.map(id => ({ id, state: 'checking', blocking: id === 'hooks', detail: null, error: null }))
        setImmediate(() => { services.checks().then(rows => { for (const data of rows) publish({ type: 'setup.check', at: now(), data }) }).catch(() => {
          for (const check of checks) publish({ type: 'setup.check', at: now(), data: { ...check, state: 'failed', error: 'Check failed' } })
        }) })
        return ok({ checks })
      }
      if (route === 'sessions') {
        const id = resolveRepo(q)
        const states = q.get('state')?.split(',')
        if (states?.some(state => !validStates.includes(state))) throw apiError(422, 'validation_failed')
        // archived=1: only archived sessions, any age, ordered archivedAt desc then id. One archive-finished call or
        // sweep stamps every session with the same ms, so its cursor is the opaque `<archivedAt>:<id>` of the last
        // row, and the next page starts after that row in the same order; a bare ms `before` keeps every older one.
        // archived=0: only sessions that are not archived. Without it, every session as before, `before` on startedAt.
        const archived = q.get('archived')
        if (archived !== null && !['0', '1'].includes(archived)) throw apiError(422, 'validation_failed', { fields: ['archived'] })
        const limit = integer(q, 'limit', 100, 1000)
        const cursor = archived === '1' && q.get('before')?.match(/^(\d+):(.+)$/s)
        const before = cursor ? Number(cursor[1]) : integer(q, 'before', Number.MAX_SAFE_INTEGER)
        if (cursor && (!Number.isSafeInteger(before) || before < 1)) throw apiError(422, 'validation_failed', { fields: ['before'] })
        const key = archived === '1' ? 'archivedAt' : 'startedAt'
        const after = row => row[key] < before || (cursor && row[key] === before && row.id.localeCompare(cursor[2]) > 0)
        const all = projector.snapshot().sessions.filter(row => (!id || row.repoId === id) && (!states || states.includes(row.state)) && (q.get('active') !== '1' || row.state !== 'ended') &&
          (archived === null || (archived === '1') === (row.archivedAt !== null)) && after(row)).sort((a, b) => b[key] - a[key] || a.id.localeCompare(b.id))
        const rows = all.slice(0, limit)
        const last = rows.at(-1)
        return ok({ sessions: rows, nextBefore: all.length > limit ? (archived === '1' ? `${last.archivedAt}:${last.id}` : last[key]) : null })
      }
      if (s[1] === 'sessions' && s.length === 3) {
        const row = session(s[2])
        return ok({ session: row, requests: projector.snapshot().requests.filter(request => request.sessionId === row.id), steps: steps(row.id, q) })
      }
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'steps') return ok({ steps: steps(s[2], q) })
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'diff') {
        const row = session(s[2])
        if (!q.has('path')) throw apiError(422, 'validation_failed', { fields: ['path'] })
        try { return ok(await (approvals?.diff ?? sessionDiff)(store.get('SELECT * FROM sessions WHERE id=?', row.id), q.get('path'))) } catch (error) {
          if (!(error instanceof DiffError)) throw error
          throw error.code === 'not_found' ? apiError(404, 'not_found', { entity: 'path' }) : apiError(422, 'validation_failed', { fields: ['path'] })
        }
      }
      if (route === 'rules') return ok(await rulesBody(q))
      if (route === 'meetings') return ok(await meetingList(q))
      if (route === 'meetings/search') return ok(await meetingSearch(q))
      if (s[1] === 'meetings' && s.length === 3) return ok(await meetingDetail(s[2]))
      if (s[1] === 'meetings' && s.length === 4 && s[3] === 'transcript') return ok(await meetingTranscript(s[2]))
      if (s[1] === 'meetings' && s.length === 4 && s[3] === 'log') return ok(await meetingLog(s[2], q))
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'disk') return ok(await services.disk(filePath(session(s[2]).cwd, 'cwd')))
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'scrollback') return launcher.scrollback(session(s[2]).id, integer(q, 'lines', SCROLLBACK_LINES, SCROLLBACK_LINES_MAX))
      if (route === 'requests') {
        const state = q.get('state') ?? 'open'
        if (!['open', 'answered', 'expired'].includes(state)) throw apiError(422, 'validation_failed')
        const repoId = resolveRepo(q)
        const sessions = projector.snapshot().sessions
        return ok({ requests: projector.snapshot().requests.filter(row => row.state === state && (!q.has('sessionId') || row.sessionId === q.get('sessionId')) && (!q.has('taskId') || row.taskId === q.get('taskId')) && (!q.has('runId') || sessions.some(session => session.id === row.sessionId && session.runRef?.runId === q.get('runId') && (!repoId || session.runRef.repoId === repoId)))) })
      }
      if (route === 'history') {
        const id = resolveRepo(q)
        const limit = integer(q, 'limit', 100, 1000)
        const before = integer(q, 'before', Number.MAX_SAFE_INTEGER)
        const rows = store.all(`SELECT * FROM session_summaries WHERE started_at<?${id ? ' AND repo_id=?' : ''} ORDER BY started_at DESC,session_id LIMIT ?`, before, ...(id ? [id] : []), limit + 1)
        return ok({ summaries: rows.slice(0, limit).map(row => ({ ...camel(row), claudeSessionIds: JSON.parse(row.claude_session_ids) })), nextBefore: rows.length > limit ? rows[limit - 1].started_at : null })
      }
      if (route === 'runs') return ok({ runs: await runs(q) })
      if (s[1] === 'runs' && s.length === 4) {
        const id = resolveRepo(q, s[2])
        const run = withLeads(await runReader.list()).find(run => run.repoId === id && run.runId === s[3])
        if (!run) throw apiError(404, 'not_found')
        if (run.readError) throw apiError(502, 'run_unreadable', { file: run.readError.file })
        return ok({ run })
      }
      if (s[1] === 'runs' && s.length === 5 && s[4] === 'plan') {
        const id = resolveRepo(q, s[2])
        const run = (await runReader.list()).find(run => run.repoId === id && run.runId === s[3])
        if (!run) throw apiError(404, 'not_found')
        return ok({ path: run.planPath, ...(await readRunPlan(await resolveRunPlan(run, run.repoId))) })
      }
    }
    if (method === 'PATCH' && route === 'prefs') {
      const current = preferences()
      for (const [key, value] of Object.entries(body)) {
        if (!validatePref(key, value)) throw apiError(422, 'validation_failed', { fields: [key] })
        if (current.sources[key] === 'env') throw apiError(409, 'read_only_pref', { fields: [key] })
      }
      const fileChanges = Object.entries(body).filter(([key]) => configKeys.has(key))
      if (fileChanges.length) {
        let config = {}
        try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw apiError(500, 'settings_io_failed') }
        fs.mkdirSync(paths.config, { recursive: true, mode: 0o700 })
        fs.chmodSync(paths.config, 0o700)
        const temp = `${configFile}.${process.pid}.tmp`
        try {
          fs.writeFileSync(temp, JSON.stringify({ ...config, ...Object.fromEntries(fileChanges) }) + '\n', { mode: 0o600, flag: 'wx' })
          fs.renameSync(temp, configFile)
        } catch { throw apiError(500, 'settings_io_failed') } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
      }
      store.tx(() => {
        for (const [key, value] of Object.entries(body).filter(([key]) => !configKeys.has(key))) store.run('INSERT INTO prefs(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', key, JSON.stringify(value), now())
      })
      const updated = preferences()
      event('prefs.changed', updated)
      return ok(updated)
    }
    if (method === 'PATCH' && s[1] === 'repos' && s.length === 4 && s[3] === 'crew') {
      const id = resolveRepo(q, s[2])
      const keys = Object.keys(body)
      const unknown = keys.filter(key => !['seed', 'slot', 'hat', 'slotShared'].includes(key))
      if (!keys.length || unknown.length) throw apiError(422, 'validation_failed', { fields: unknown.length ? unknown : ['seed', 'slot', 'hat'] })
      const row = store.get('SELECT name FROM repos WHERE id=?', id)
      const { seed, slot, hat, slotShared } = body
      const reroll = typeof seed === 'string' && seed.startsWith(`${row.name}#`) ? seed.slice(row.name.length + 1) : null
      if (seed !== undefined && seed !== row.name && !(/^[1-9]\d{0,2}$/.test(reroll ?? '') && Number(reroll) >= 2)) throw apiError(422, 'validation_failed', { fields: ['seed'] })
      if (slot !== undefined && !(Number.isInteger(slot) && slot >= 0 && slot <= 8)) throw apiError(422, 'validation_failed', { fields: ['slot'] })
      if (hat !== undefined && !hats.includes(hat)) throw apiError(422, 'validation_failed', { fields: ['hat'] })
      if (slotShared !== undefined && typeof slotShared !== 'boolean') throw apiError(422, 'validation_failed', { fields: ['slotShared'] })
      // One transaction (design/crew.md 4.2): a taken slot rolls back the seed and hat written before it.
      store.tx(() => {
        if (seed !== undefined) store.run('UPDATE repos SET crew_seed=? WHERE id=?', seed, id)
        if (hat !== undefined) store.run('UPDATE repos SET hat=? WHERE id=?', hat, id)
        if (slot !== undefined) {
          // A shared slot (Undo of a move away from one) skips the taken check; others still hold it.
          if (slotShared !== true && store.get('SELECT id FROM repos WHERE crew_slot=? AND crew_slot_shared=0 AND archived_at IS NULL AND id<>?', slot, id)) throw apiError(409, 'slot_taken', { fields: ['slot'] })
          store.run('UPDATE repos SET crew_slot=?,crew_slot_shared=? WHERE id=?', slot, slotShared === true ? 1 : 0, id)
        }
      })
      const repo = repos(true).find(candidate => candidate.id === id)
      event('repo.upserted', repo, id)
      return ok({ repo })
    }
    if (method === 'POST') {
      if (Object.keys(body).length && !takesBody(route, s)) throw apiError(422, 'validation_failed')
      if (s[1] === 'requests' && s.length === 4 && s[3] === 'answer') {
        onlyKeys(body, bodyKeys.answer)
        const { request } = await m3().deliverer.answer(s[2], body, { via: 'browser' })
        return { status: 202, data: { request } }
      }
      if (route === 'requests/answer-batch') {
        onlyKeys(body, bodyKeys.batch)
        if (body.choice !== 'allow') throw apiError(422, 'validation_failed', { fields: ['choice'] })
        return { status: 202, data: { results: await m3().deliverer.batch(body.ids) } }
      }
      if (s[1] === 'requests' && s.length === 4 && s[3] === 'followup') {
        onlyKeys(body, bodyKeys.followup)
        await m3().deliverer.followup(s[2], body.text)
        return { status: 202, data: {} }
      }
      if (route === 'rules') {
        onlyKeys(body, bodyKeys.rule)
        const { repoId, pattern } = ruleTarget(body)
        if (!['suggested', 'manual'].includes(body.source)) throw apiError(422, 'validation_failed', { fields: ['source'] })
        const { rule } = await m3().rules.write(repoId, pattern, { source: body.source })
        return { status: 201, data: { rule } }
      }
      if (route === 'rules/suggestions/dismiss') {
        onlyKeys(body, bodyKeys.dismiss)
        const { repoId, pattern } = ruleTarget(body)
        if (!m3().rules.dismissOffer(repoId, pattern)) throw apiError(404, 'not_found', { entity: 'offer' })
        return { status: 204, data: undefined }
      }
      if (route === 'open') {
        const request = parseOpenRequest(body)
        if (request.kind !== 'runPlan') {
          await openMeeting(request)
          return { status: 202, data: {} }
        }
        const { ref } = request
        const run = (await runReader.list()).find(run => run.repoId === ref.repoId && run.runId === ref.runId)
        if (!run) throw apiError(404, 'not_found')
        await services.open(await resolveRunPlan(run, run.repoId))
        return { status: 202, data: {} }
      }
      if (route === 'meetings/start') {
        onlyKeys(body, bodyKeys.start)
        return { status: 202, data: { recorder: recorderView(await mtg().recorder.start(body.tag)) } }
      }
      if (route === 'meetings/stop') return { status: 202, data: { recorder: recorderView(mtg().recorder.stop()) } }
      if (s[1] === 'meetings' && s.length === 4 && s[3] === 'pins') return meetingPin(s[2], body)
      if (s[1] === 'meetings' && s.length === 6 && s[3] === 'items' && s[5] === 'dismiss') {
        const row = meetingRow(s[2])
        if (!/^[0-9a-f]{40}$/.test(s[4]) || !dismissItem(store, row.id, s[4], now()).dismissed) throw apiError(404, 'not_found')
        return { status: 204, data: undefined }
      }
      if (route === 'ask') return meetingAsk(body)
      if (route === 'sessions') {
        const unknown = Object.keys(body).filter(key => !['repoKey', 'task', 'mode'].includes(key))
        if (unknown.length || body.repoKey !== undefined && typeof body.repoKey !== 'string') throw apiError(422, 'validation_failed', { fields: unknown.length ? unknown : ['repoKey'] })
        const repoId = resolveRepo(q, body.repoKey)
        if (!repoId) throw apiError(422, 'validation_failed', { fields: ['repoKey'] })
        return launcher.launch(repoId, body)
      }
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'stop') return launcher.stop(session(s[2]).id)
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'nudge') return launcher.nudge(session(s[2]).id)
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'relaunch') return launcher.relaunch(session(s[2]).id)
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'archive') {
        const result = projector.archive(session(s[2]).id, 'owner')
        if (!Array.isArray(result)) throw apiError(result.code === 'needs_you' ? 409 : 404, result.code)
        return ok({ session: session(s[2]) })
      }
      if (s[1] === 'sessions' && s.length === 4 && s[3] === 'unarchive') {
        const row = session(s[2])
        if (row.archivedAt !== null) projector.unarchive(row.id)
        return ok({ session: session(row.id) })
      }
      if (route === 'sessions/archive-finished') return ok({ ids: projector.archiveFinished() })
      if (route === 'setup/hooks') return ok(await services.installHooks())
      if (route === 'setup/complete') {
        if (!(await services.checks()).some(check => check.id === 'hooks' && check.state === 'ok')) throw apiError(409, 'precondition_failed')
        const firstRunCompletedAt = preferences().prefs.firstRunCompletedAt ?? now()
        store.run('INSERT INTO prefs(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', 'firstRunCompletedAt', JSON.stringify(firstRunCompletedAt), now())
        event('prefs.changed', preferences())
        return ok({ firstRunCompletedAt })
      }
      if (route === 'notify/test') return ok(await services.notify())
      if (route === 'repos/rescan') {
        filePath(preferences().prefs.scanRoot, 'scanRoot')
        return { status: 202, data: await services.rescan() }
      }
      if (s[1] === 'deps' && s.length === 4 && ['start', 'retry'].includes(s[3])) {
        const allowed = s[3] === 'start' ? ['deckd', 'scribed'] : ['deckd', 'vault-mcp', 'scribed', 'notify']
        if (!allowed.includes(s[2])) throw apiError(404, 'not_found')
        const dep = await services[s[3] === 'start' ? 'startDependency' : 'retryDependency'](s[2])
        event('health.changed', dep)
        return { status: 202, data: { dep } }
      }
      if (s[1] === 'sessions' && s.length === 4 && ['mark-reviewed', 'dismiss'].includes(s[3])) {
        const row = session(s[2])
        if (row.state !== (s[3] === 'mark-reviewed' ? 'done' : 'crashed')) throw apiError(409, 'invalid_state', { state: row.state })
        if (s[3] === 'mark-reviewed') projector.signal(row.id, { type: 'review' }, now())
        else {
          store.tx(() => {
            store.run('UPDATE sessions SET state=?,alive=0,state_since=? WHERE id=?', 'ended', now(), row.id)
            persistSessionSummary(store, store.get('SELECT * FROM sessions WHERE id=?', row.id))
          })
          event('session.upserted', session(row.id), row.id)
          event('counts', projectCounts(store))
        }
        return ok({ session: session(row.id) })
      }
    }
    if (method === 'DELETE') {
      if (s[1] === 'meetings' && s.length === 5 && s[3] === 'pins') {
        const row = meetingRow(s[2])
        const { removed, events } = removePin(store, row.id, s[4], now())
        if (!removed) throw apiError(404, 'not_found')
        publishStored(events)
        return { status: 204, data: undefined }
      }
      if (s[1] === 'meetings' && s.length === 6 && s[3] === 'items' && s[5] === 'dismiss') {
        mtg()
        undismissItem(store, s[2], s[4])
        return { status: 204, data: undefined }
      }
      if (s[1] === 'rules' && s.length === 4) {
        // `?undo=1` is the toast Undo after accepting a suggestion: rule_audit records `undo` instead of `revoked`.
        const undo = q.get('undo')
        if (undo !== null && undo !== '1') throw apiError(422, 'validation_failed', { fields: ['undo'] })
        return ok(m3().rules.revoke(resolveRepo(new URLSearchParams(), s[2]), s[3], { undo: undo === '1' }))
      }
    }
    throw apiError(404, 'not_found')
  }
  /**
   * The answer and rule codes take the statuses of `codeStatus`, and deckd down (503), the typing guard and a
   * settings file that kept changing are `retryable: true` (05-api 2.3, 2.4 and 4); every other error is the router's.
   */
  async function handle(request) {
    try { return await route(request) } catch (error) {
      const code = error?.code
      if (!error?.status || typeof code !== 'string' || (!Object.hasOwn(codeStatus, code) && !(code === 'deckd_unavailable' && error.status === 503))) throw error
      const details = error.details && Object.keys(error.details).length ? { details: error.details } : {}
      return { status: codeStatus[code] ?? error.status, data: { error: { code, message: code, retryable: retryableCodes.has(code), ...details } } }
    }
  }
  return { route: handle, snapshot, preferences, repos, withLeads, close: () => launcher.close() }
}
