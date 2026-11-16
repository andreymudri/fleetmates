// The `ticket` command and the two places a run touches a ticket: `init-run --ticket` and `finish`
// (docs/specs/2026-11-16-tickets-design.md). The store is scripts/tickets.mjs.
//
// Ticket text is written by other sessions. Every line printed here that carries it goes through
// `printable`, so a title cannot move the cursor or repaint a line of the terminal it is read in.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { printable, printableBlock } from './reviews.mjs'
import {
  TicketError, addTicket, attachRun, checkAttach, claimTicket, closeTicket, editTicket, linkTicket, listTickets, noteTicket,
  openTickets, parseTicketId, releaseTicket, renderList, renderTicket, reopenTicket, showTicket, ticketIdentity, ticketOfRun,
  ticketsPath, unlinkTicket,
} from './tickets.mjs'

// The flags each subcommand reads. A flag that belongs to another subcommand is refused by name:
// `ticket claim 3 --done` must not look as if it closed anything.
export const TICKET_FLAGS = {
  add: ['body', 'priority', 'ref', 'after'],
  list: ['all', 'json'],
  show: ['json'],
  note: [],
  edit: ['title', 'body', 'priority', 'ref'],
  claim: ['take'],
  release: [],
  close: ['done', 'dropped', 'note'],
  reopen: ['note'],
  link: ['after'],
  unlink: ['after'],
}

// True when git ignores the file, and also when there is no repository to commit it to.
function ignoredByGit(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: path.dirname(file), stdio: 'ignore', timeout: 5000, windowsHide: true })
    return true
  } catch (error) {
    return error.status !== 1
  }
}

const value = (flags, name) => {
  if (flags[name] === undefined) return undefined
  if (typeof flags[name] !== 'string') throw new TicketError(`write \`--${name} <value>\``)
  return flags[name]
}

const required = (flags, name) => {
  const v = value(flags, name)
  if (v === undefined) throw new TicketError(`missing --${name} <value>`)
  return v
}

const on = (flags, name) => {
  if (flags[name] === undefined) return false
  if (flags[name] !== true) throw new TicketError(`\`--${name}\` takes no value`)
  return true
}

export async function runTicketCommand({ root, flags, positional, io, env = process.env, now = Date.now() }) {
  const [sub, ...args] = positional
  let db = null
  try {
    if (!Object.hasOwn(TICKET_FLAGS, sub ?? '')) {
      throw new TicketError(`ticket needs a subcommand: ${Object.keys(TICKET_FLAGS).join(', ')}`)
    }
    const strays = Object.keys(flags).filter((name) => name !== 'root' && !TICKET_FLAGS[sub].includes(name))
    if (strays.length > 0) throw new TicketError(`ticket ${sub} does not take ${strays.map((f) => `--${f}`).join(', ')}`)
    const identity = ticketIdentity(env)
    const file = ticketsPath(root)
    const fresh = sub === 'add' && !existsSync(file)
    db = await openTickets(file, { create: sub === 'add' })
    // Tickets are meant to stay on this machine. Run state has the same home and most
    // repositories already ignore it; say so once, when the file is made, where they do not.
    if (fresh && !ignoredByGit(file)) {
      io.out('note: .fleetmates/ is not ignored by git in this repository. Add `.fleetmates/` to .gitignore so tickets are never committed.')
    }

    if (sub === 'list') {
      const json = on(flags, 'json')
      const tickets = db ? listTickets(db, { all: on(flags, 'all') }) : []
      if (json) io.out(JSON.stringify(tickets, null, 2))
      else if (tickets.length > 0) io.out(printableBlock(renderList(tickets, { now })))
      return 0
    }
    if (sub === 'add') {
      const title = args.join(' ')
      const after = value(flags, 'after')
      const id = addTicket(db, {
        title, body: value(flags, 'body') ?? '', priority: value(flags, 'priority') ?? 'normal', ref: value(flags, 'ref') ?? null,
        after: after === undefined ? [] : [parseTicketId(after)], identity, now,
      })
      io.out(`created ticket #${id}`)
      return 0
    }

    const id = parseTicketId(args[0])
    if (!db) throw new TicketError(`there is no ticket #${id}: this repository has no tickets`)
    if (sub === 'show') {
      const ticket = showTicket(db, id)
      io.out(on(flags, 'json') ? JSON.stringify(ticket, null, 2) : printableBlock(renderTicket(ticket, { now })))
    } else if (sub === 'note') {
      noteTicket(db, id, { text: args.slice(1).join(' '), identity, now })
      io.out(`noted on ticket #${id}`)
    } else if (sub === 'edit') {
      editTicket(db, id, { title: value(flags, 'title'), body: value(flags, 'body'), priority: value(flags, 'priority'), ref: value(flags, 'ref'), identity, now })
      io.out(`edited ticket #${id}`)
    } else if (sub === 'claim') {
      const outcome = claimTicket(db, id, { identity, take: on(flags, 'take'), now })
      io.out({ claimed: `claimed ticket #${id}`, held: `ticket #${id} is already yours`, taken: `took ticket #${id} over` }[outcome])
    } else if (sub === 'release') {
      releaseTicket(db, id, { identity, now })
      io.out(`released ticket #${id}`)
    } else if (sub === 'close') {
      const done = on(flags, 'done'), dropped = on(flags, 'dropped')
      if (done === dropped) throw new TicketError('close needs exactly one of --done and --dropped')
      closeTicket(db, id, { reason: done ? 'done' : 'dropped', text: required(flags, 'note'), identity, now })
      io.out(`closed ticket #${id} as ${done ? 'done' : 'dropped'}`)
    } else if (sub === 'reopen') {
      reopenTicket(db, id, { text: required(flags, 'note'), identity, now })
      io.out(`reopened ticket #${id}`)
    } else if (sub === 'link') {
      const after = parseTicketId(required(flags, 'after'))
      io.out(linkTicket(db, id, { after, identity, now }) ? `ticket #${id} now waits for #${after}` : `ticket #${id} already waits for #${after}`)
    } else if (sub === 'unlink') {
      const after = parseTicketId(required(flags, 'after'))
      unlinkTicket(db, id, { after, identity, now })
      io.out(`ticket #${id} no longer waits for #${after}`)
    }
    return 0
  } catch (error) {
    if (!(error instanceof TicketError)) throw error
    io.out(`ticket: ${printable(error.message)}`)
    return error.code
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

// `init-run --ticket <id>`, first half: refuse before any run state is written. Returns a refusal
// `{ code, message }`, or null when the run may start.
export async function ticketRefusalForRun({ root, ticket, env = process.env }) {
  let db = null
  try {
    if (typeof ticket !== 'string') throw new TicketError('write `--ticket <id>`')
    const id = parseTicketId(ticket)
    db = await openTickets(ticketsPath(root))
    if (!db) throw new TicketError(`there is no ticket #${id}: this repository has no tickets`)
    checkAttach(db, id, { identity: ticketIdentity(env) })
    return null
  } catch (error) {
    if (!(error instanceof TicketError)) throw error
    return { code: error.code, message: `init-run: ${printable(error.message)}` }
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

// Second half, after the run state exists: claim the ticket and record the plan and the run on it.
export async function attachTicketToRun({ root, ticket, planPath, runId, env = process.env, now = Date.now() }) {
  const db = await openTickets(ticketsPath(root))
  try {
    const id = parseTicketId(ticket)
    attachRun(db, id, { planPath, runId, identity: ticketIdentity(env), now })
    return id
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

// `finish`, for a run that has a ticket: one note with the outcome, and a reminder. It never
// closes the ticket, because a merge or a release can still fail after `finish` passes. Returns the
// line to print, or null. A ticket file that cannot be read must not change what `finish` reports.
export async function noteFinishOnTicket({ root, runId, complete, env = process.env, now = Date.now() }) {
  let db = null
  try {
    db = await openTickets(ticketsPath(root))
    if (!db) return null
    const id = ticketOfRun(db, runId)
    if (id === null) return null
    noteTicket(db, id, { text: `finish for run ${runId}: ${complete ? 'every phase passed' : 'the run is not finished'}`, identity: ticketIdentity(env), now })
    return complete
      ? `ticket #${id} belongs to this run. Close it once the work has landed: ticket close ${id} --done --note "<what proved it>"`
      : `ticket #${id} belongs to this run and stays open.`
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}
