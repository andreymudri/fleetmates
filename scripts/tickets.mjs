// Tickets: a backlog that outlives a session, and an advisory claim per ticket so that sessions
// working in one repository can see what another has taken
// (docs/specs/2026-11-16-tickets-design.md).
//
// One SQLite file, `.fleetmates/tickets.db`, in the MAIN checkout: every worktree of a repository
// shares it, and `.fleetmates/` is ignored by git, so a ticket never reaches the repository.
//
// A claim is advisory. Nothing here stops a session from editing files without one; the claim
// only decides what these commands, and `init-run --ticket`, refuse.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export const SCHEMA_VERSION = 1
export const PRIORITIES = ['high', 'normal', 'low']
export const CLOSE_REASONS = ['done', 'dropped']
// The identity of a change made outside a Claude Code session.
export const TERMINAL = 'terminal'
const BUSY_TIMEOUT_MS = 5000
const MAX_TITLE = 200
const MAX_TEXT = 20000

// `code` is the CLI's exit code: 1 when the command ran and declined, 2 for a malformed request.
export class TicketError extends Error {
  constructor(message, code = 2) {
    super(message)
    this.name = 'TicketError'
    this.code = code
  }
}

export function ticketIdentity(env = process.env) {
  const id = env.CLAUDE_CODE_SESSION_ID
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : TERMINAL
}

// The main checkout of the repository `root` is in, so a command run in a linked worktree reads
// the same file as one run in the main checkout. Outside a git repository it is `root` itself.
export function mainCheckout(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
    if (common && path.basename(common) === '.git') return path.dirname(common)
  } catch { /* not a repository: tickets live beside the given root */ }
  return path.resolve(root)
}

export const ticketsPath = (root) => path.join(mainCheckout(root), '.fleetmates', 'tickets.db')

// `node:sqlite` prints an ExperimentalWarning when it is first loaded on the Node versions that
// still mark it experimental. That line would land on stderr of every ticket command and of the
// session start hook, so it is dropped for this one import and nothing else.
let sqlite = null
async function loadSqlite() {
  if (sqlite) return sqlite
  const emit = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? ''
    if (/SQLite/i.test(text)) return
    return emit.call(process, warning, ...rest)
  }
  try { sqlite = await import('node:sqlite') } finally { process.emitWarning = emit }
  return sqlite
}

const SCHEMA = `
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  close_reason TEXT CHECK (close_reason IN ('done', 'dropped')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
  ref TEXT,
  holder TEXT,
  claimed_at INTEGER,
  plan_path TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  author TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE blockers (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  blocked_by INTEGER NOT NULL REFERENCES tickets(id),
  PRIMARY KEY (ticket_id, blocked_by)
);
`

// Opens the ticket file. Returns null when it does not exist and `create` is false: a repository
// without tickets has no file, and no reader makes one.
//
// Throws TicketError when the file is not a ticket database or was written by a newer version.
// Nothing here repairs or replaces a file it cannot read.
export async function openTickets(file, { create = false, readOnly = false } = {}) {
  const exists = existsSync(file)
  if (!exists && !create) return null
  const { DatabaseSync } = await loadSqlite()
  if (!exists) mkdirSync(path.dirname(file), { recursive: true })
  let db
  try {
    db = new DatabaseSync(file, { readOnly: readOnly && exists })
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > SCHEMA_VERSION) {
      throw new TicketError(`${file} was written by a newer fleetmates (ticket schema ${version}, this one reads ${SCHEMA_VERSION}); update fleetmates`, 4)
    }
    if (version === 0) {
      if (readOnly && exists) throw new TicketError(`${file} is not a ticket database`, 4)
      db.exec('BEGIN IMMEDIATE')
      // Another process may have created the schema between the check and the lock.
      if (db.prepare('PRAGMA user_version').get().user_version === 0) {
        db.exec(SCHEMA)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      }
      db.exec('COMMIT')
    }
    db.exec('PRAGMA foreign_keys = ON')
    return db
  } catch (error) {
    try { db?.close() } catch { /* already closed */ }
    if (error instanceof TicketError) throw error
    throw new TicketError(`cannot read the ticket file ${file}: ${error.message}`, 4)
  }
}

// One write, all or nothing. IMMEDIATE takes the write lock before the first read, so two
// processes that claim the same ticket cannot both read it as free.
function transaction(db, body) {
  try {
    db.exec('BEGIN IMMEDIATE')
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* the transaction is already gone */ }
    if (error instanceof TicketError) throw error
    if (/busy|locked/i.test(error.message)) throw new TicketError('the ticket file is busy; another command is writing it. Run the command again.', 1)
    throw error
  }
}

const text = (value, name, { max = MAX_TEXT, empty = false } = {}) => {
  if (typeof value !== 'string' || (!empty && value.trim() === '')) throw new TicketError(`${name} must not be empty`)
  if (value.length > max) throw new TicketError(`${name} is longer than ${max} characters`)
  return value.trim()
}

export function parseTicketId(value) {
  const match = /^#?([1-9]\d{0,8})$/.exec(String(value ?? ''))
  if (!match) throw new TicketError(`a ticket id is a positive number, got ${JSON.stringify(value ?? null)}`)
  return Number(match[1])
}

const priorityOf = (value) => {
  if (!PRIORITIES.includes(value)) throw new TicketError(`priority must be one of ${PRIORITIES.join(', ')}`)
  return value
}

function row(db, id) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id)
  if (!ticket) throw new TicketError(`there is no ticket #${id}`)
  return ticket
}

const note = (db, id, author, kind, body, now) =>
  db.prepare('INSERT INTO notes (ticket_id, author, at, kind, text) VALUES (?, ?, ?, ?, ?)').run(id, author, now, kind, body)

// The prerequisites that still block a ticket: the open ones, and the ones closed as dropped. A
// dropped prerequisite keeps blocking until it is unlinked, because the work the ticket depended
// on was not done and someone has to decide what that means.
export function blockersOf(db, id) {
  return db.prepare(`SELECT t.id, t.title, t.state, t.close_reason FROM blockers b JOIN tickets t ON t.id = b.blocked_by
    WHERE b.ticket_id = ? AND (t.state = 'open' OR t.close_reason = 'dropped') ORDER BY t.id`).all(id)
}

const blockedMessage = (id, blockers) => `ticket #${id} is blocked by ` + blockers.map((b) =>
  b.state === 'open' ? `#${b.id} (open)` : `#${b.id} (dropped: unlink it to go on without it)`).join(', ')

// Another identity's ticket may be read and noted on. Changing or releasing it means taking it
// over first, which is recorded.
function assertMayChange(ticket, identity, action) {
  if (ticket.holder && ticket.holder !== identity) {
    throw new TicketError(`ticket #${ticket.id} is held by ${ticket.holder}; take it over with \`ticket claim ${ticket.id} --take\` before you ${action} it`, 1)
  }
}

export function addTicket(db, { title, body = '', priority = 'normal', ref = null, after = [], identity, now = Date.now() }) {
  const clean = { title: text(title, 'the title', { max: MAX_TITLE }), body: text(body, 'the body', { empty: true }), priority: priorityOf(priority),
    ref: ref === null ? null : text(ref, 'the reference', { max: MAX_TITLE }) }
  return transaction(db, () => {
    for (const prerequisite of after) row(db, prerequisite)
    const id = Number(db.prepare('INSERT INTO tickets (title, body, priority, ref, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(clean.title, clean.body, clean.priority, clean.ref, now, identity).lastInsertRowid)
    for (const prerequisite of new Set(after)) db.prepare('INSERT INTO blockers (ticket_id, blocked_by) VALUES (?, ?)').run(id, prerequisite)
    return id
  })
}

// Open tickets by priority, then creation. A blocked ticket is listed and marked, never hidden.
export function listTickets(db, { all = false } = {}) {
  const rows = db.prepare(`SELECT * FROM tickets ${all ? '' : "WHERE state = 'open'"}
    ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id`).all()
  return rows.map((ticket) => ({ ...ticket, blockedBy: blockersOf(db, ticket.id).map((b) => b.id) }))
}

export function showTicket(db, id) {
  const ticket = row(db, id)
  return {
    ...ticket,
    blockedBy: blockersOf(db, id).map((b) => b.id),
    after: db.prepare('SELECT blocked_by FROM blockers WHERE ticket_id = ? ORDER BY blocked_by').all(id).map((r) => r.blocked_by),
    notes: db.prepare('SELECT author, at, kind, text FROM notes WHERE ticket_id = ? ORDER BY id').all(id),
  }
}

export function noteTicket(db, id, { text: body, identity, now = Date.now() }) {
  const clean = text(body, 'the note')
  return transaction(db, () => { row(db, id); note(db, id, identity, 'note', clean, now) })
}

export function editTicket(db, id, { title, body, priority, ref, identity, now = Date.now() }) {
  const changes = {}
  if (title !== undefined) changes.title = text(title, 'the title', { max: MAX_TITLE })
  if (body !== undefined) changes.body = text(body, 'the body', { empty: true })
  if (priority !== undefined) changes.priority = priorityOf(priority)
  if (ref !== undefined) changes.ref = text(ref, 'the reference', { max: MAX_TITLE })
  const fields = Object.keys(changes)
  if (fields.length === 0) throw new TicketError('edit needs at least one of --title, --body, --priority, --ref')
  return transaction(db, () => {
    assertMayChange(row(db, id), identity, 'edit')
    db.prepare(`UPDATE tickets SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...fields.map((f) => changes[f]), id)
    note(db, id, identity, 'edit', `changed ${fields.join(', ')}`, now)
  })
}

// Returns what happened: 'claimed', 'held' (the caller already holds it) or 'taken'.
export function claimTicket(db, id, { identity, take = false, now = Date.now() }) {
  return transaction(db, () => {
    const ticket = row(db, id)
    if (ticket.state !== 'open') throw new TicketError(`ticket #${id} is closed; reopen it before claiming it`, 1)
    if (ticket.holder === identity) return 'held'
    if (ticket.holder && !take) {
      throw new TicketError(`ticket #${id} is held by ${ticket.holder} since ${new Date(ticket.claimed_at).toISOString()}; `
        + `add --take to take it over`, 1)
    }
    const blockers = blockersOf(db, id)
    if (blockers.length > 0) throw new TicketError(blockedMessage(id, blockers), 1)
    db.prepare('UPDATE tickets SET holder = ?, claimed_at = ? WHERE id = ?').run(identity, now, id)
    note(db, id, identity, ticket.holder ? 'take' : 'claim', ticket.holder ? `took the ticket over from ${ticket.holder}` : 'claimed the ticket', now)
    return ticket.holder ? 'taken' : 'claimed'
  })
}

export function releaseTicket(db, id, { identity, now = Date.now() }) {
  return transaction(db, () => {
    const ticket = row(db, id)
    if (!ticket.holder) throw new TicketError(`ticket #${id} is not claimed`, 1)
    assertMayChange(ticket, identity, 'release')
    db.prepare('UPDATE tickets SET holder = NULL, claimed_at = NULL WHERE id = ?').run(id)
    note(db, id, identity, 'release', 'released the ticket', now)
  })
}

export function closeTicket(db, id, { reason, text: body, identity, now = Date.now() }) {
  if (!CLOSE_REASONS.includes(reason)) throw new TicketError('close needs exactly one of --done and --dropped')
  const clean = text(body, 'the closing note (--note)')
  return transaction(db, () => {
    const ticket = row(db, id)
    if (ticket.state === 'closed') throw new TicketError(`ticket #${id} is already closed`, 1)
    assertMayChange(ticket, identity, 'close')
    db.prepare("UPDATE tickets SET state = 'closed', close_reason = ?, holder = NULL, claimed_at = NULL WHERE id = ?").run(reason, id)
    note(db, id, identity, `close-${reason}`, clean, now)
  })
}

export function reopenTicket(db, id, { text: body, identity, now = Date.now() }) {
  const clean = text(body, 'the reopening note (--note)')
  return transaction(db, () => {
    if (row(db, id).state !== 'closed') throw new TicketError(`ticket #${id} is not closed`, 1)
    db.prepare("UPDATE tickets SET state = 'open', close_reason = NULL, holder = NULL, claimed_at = NULL WHERE id = ?").run(id)
    note(db, id, identity, 'reopen', clean, now)
  })
}

// Whether `from` already depends on `target`, directly or through other tickets.
function dependsOn(db, from, target, seen = new Set()) {
  if (from === target) return true
  if (seen.has(from)) return false
  seen.add(from)
  return db.prepare('SELECT blocked_by FROM blockers WHERE ticket_id = ?').all(from).some((r) => dependsOn(db, r.blocked_by, target, seen))
}

export function linkTicket(db, id, { after, identity, now = Date.now() }) {
  return transaction(db, () => {
    const ticket = row(db, id)
    row(db, after)
    assertMayChange(ticket, identity, 'link')
    if (dependsOn(db, after, id)) throw new TicketError(`ticket #${after} already depends on #${id}; the link would form a cycle`, 1)
    if (db.prepare('SELECT 1 FROM blockers WHERE ticket_id = ? AND blocked_by = ?').get(id, after)) return false
    db.prepare('INSERT INTO blockers (ticket_id, blocked_by) VALUES (?, ?)').run(id, after)
    note(db, id, identity, 'link', `now waits for #${after}`, now)
    return true
  })
}

export function unlinkTicket(db, id, { after, identity, now = Date.now() }) {
  return transaction(db, () => {
    assertMayChange(row(db, id), identity, 'unlink')
    const removed = db.prepare('DELETE FROM blockers WHERE ticket_id = ? AND blocked_by = ?').run(id, after).changes
    if (removed === 0) throw new TicketError(`ticket #${id} does not wait for #${after}`, 1)
    note(db, id, identity, 'unlink', `no longer waits for #${after}`, now)
  })
}

// `init-run --ticket`: the ticket is claimed when it is free and the run is recorded on it. It
// is refused when another identity holds it or a prerequisite blocks it. `checkAttach` is the
// refusal alone, so `init-run` can refuse before it writes any run state.
export function checkAttach(db, id, { identity }) {
  const ticket = row(db, id)
  if (ticket.state !== 'open') throw new TicketError(`ticket #${id} is closed; reopen it before starting a run for it`, 1)
  if (ticket.holder && ticket.holder !== identity) {
    throw new TicketError(`ticket #${id} is held by ${ticket.holder}; take it over with \`ticket claim ${id} --take\` first`, 1)
  }
  const blockers = blockersOf(db, id)
  if (blockers.length > 0) throw new TicketError(blockedMessage(id, blockers), 1)
  return ticket
}

export function attachRun(db, id, { planPath, runId, identity, now = Date.now() }) {
  return transaction(db, () => {
    checkAttach(db, id, { identity })
    db.prepare('UPDATE tickets SET holder = ?, claimed_at = COALESCE(claimed_at, ?), plan_path = ?, run_id = ? WHERE id = ?').run(identity, now, planPath, runId, id)
    note(db, id, identity, 'run', `started run ${runId} from ${planPath}`, now)
  })
}

// The open ticket a run was started for, if any.
export function ticketOfRun(db, runId) {
  return db.prepare("SELECT id FROM tickets WHERE run_id = ? AND state = 'open' ORDER BY id DESC").get(runId)?.id ?? null
}

// Counts for the session start line. Titles and bodies are never returned: ticket text is written
// by other sessions, and a session start line is not a place for it.
export function ticketCounts(db, identity) {
  const counts = db.prepare(`SELECT COUNT(*) AS open,
    COALESCE(SUM(CASE WHEN holder = ? THEN 1 ELSE 0 END), 0) AS mine,
    COALESCE(SUM(CASE WHEN holder IS NOT NULL AND holder <> ? THEN 1 ELSE 0 END), 0) AS others
    FROM tickets WHERE state = 'open'`).get(identity, identity)
  return { open: Number(counts.open), mine: Number(counts.mine), others: Number(counts.others) }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// The one line a session sees at its start, or null when there is nothing to say.
export function sessionLine({ open, mine, others }) {
  if (!open) return null
  const held = [mine ? `${mine} held by this session` : '', others ? `${others} held by other sessions` : ''].filter(Boolean)
  return `Fleetmates tickets: ${plural(open, 'open ticket')} in this repository${held.length ? ` (${held.join(', ')})` : ''}. `
    + 'List them with `cli.mjs ticket list`; the `tickets` skill says when to claim or create one.'
}

const age = (since, now) => {
  const minutes = Math.max(0, Math.floor((now - since) / 60000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

export function renderList(tickets, { now = Date.now() } = {}) {
  if (tickets.length === 0) return 'no tickets'
  return tickets.map((t) => [
    `#${t.id}`,
    t.state === 'closed' ? `closed:${t.close_reason}` : t.priority,
    t.title,
    t.holder ? `[held by ${t.holder}, ${age(t.claimed_at, now)}]` : '',
    t.blockedBy.length ? `[blocked by ${t.blockedBy.map((id) => `#${id}`).join(', ')}]` : '',
  ].filter(Boolean).join('  ')).join('\n')
}

export function renderTicket(t, { now = Date.now() } = {}) {
  const lines = [
    `#${t.id}  ${t.title}`,
    `state: ${t.state}${t.close_reason ? ` (${t.close_reason})` : ''}   priority: ${t.priority}`,
    t.holder ? `held by: ${t.holder}, ${age(t.claimed_at, now)}` : 'held by: nobody',
    t.ref ? `reference: ${t.ref}` : '',
    t.run_id ? `run: ${t.run_id} (${t.plan_path})` : '',
    t.after.length ? `waits for: ${t.after.map((id) => `#${id}`).join(', ')}${t.blockedBy.length ? `   still blocking: ${t.blockedBy.map((id) => `#${id}`).join(', ')}` : ''}` : '',
    `created: ${new Date(t.created_at).toISOString()} by ${t.created_by}`,
    t.body ? `\n${t.body}` : '',
    ...(t.notes.length ? ['', 'notes:'] : []),
    ...t.notes.map((n) => `  ${new Date(n.at).toISOString()}  ${n.author}  ${n.kind}: ${n.text}`),
  ]
  return lines.filter((line) => line !== '').join('\n')
}
