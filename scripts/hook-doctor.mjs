#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { readEvents, rotatedPath } from './event-ledger.mjs'
import { HOOK_NAMES, receiptPath, stopReceiptPath } from './context-hook.mjs'

// A failing Bash call is not something every session makes, so its receipt is reported when seen
// but never required for doctor --hooks to pass.
export const OPTIONAL_HOOKS = new Set(['PostToolUseFailure'])

// Said beside every Stop receipt, because the receipt is the easiest thing here to over-read: it
// records that the handler ran. The guard blocks in exactly one case and lets the stop through in
// every other, and a reader who sees `observed` should know which is which without opening the
// handler (scripts/orchestrator-stop.mjs). docs/reference/installation.md lists the same cases.
export const STOP_GUARD_LIMITS = Object.freeze({
  blocks: 'a session bound to a running run whose enforcement-only finish reports failed or unresolved checks; once, the harness retry is then allowed',
  allows: Object.freeze([
    'no session binding, or a run directory that no longer exists',
    'a binding that names another repository or branch than the one the session is on',
    'plan requirements changed since the binding',
    'a suspended or abandoned run',
    'the harness retry after a block (stop_hook_active)',
    'a guard that errors, times out (12 s) or is given unreadable or oversized input',
  ]),
  skipped: 'command checks and reviews are not rerun: a passing stop check is not completion evidence',
  notPrevented: 'process death and abrupt harness loss',
})

export async function hookDoctor({ env = process.env, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000, sessionId, includeStop = false } = {}) {
  const { fingerprint } = await import('./event-ledger.mjs')
  // A full receipt file is set aside as one previous generation; read it first so a hook that
  // fired just before the rotation still counts.
  const read = async (file) => [...await readEvents(rotatedPath(file)), ...await readEvents(file)]
  const events = await read(receiptPath(env))
  if (includeStop) events.push(...await read(stopReceiptPath(env)))
  const session = sessionId === undefined ? undefined : fingerprint(sessionId)
  const hooks = [...HOOK_NAMES, ...(includeStop ? ['Stop'] : [])].map(hook => {
    const observed = events.filter(e => e.kind === 'hook-fired' && e.hook === hook && e.at <= now && now - e.at <= maxAgeMs && (session === undefined || e.fingerprint === session))
    const optional = OPTIONAL_HOOKS.has(hook)
    return { hook, state: observed.length ? 'observed' : optional ? 'optional' : 'unverified', lastAt: observed.at(-1)?.at ?? null, ...(optional ? { optional } : {}) }
  })
  return { v: 1, ok: hooks.every(h => h.optional || h.state === 'observed'), hooks,
    ...(includeStop ? { stopGuard: STOP_GUARD_LIMITS } : {}),
    next: 'Use one Claude Code session to start, run Bash, compact and stop a teammate; then repeat doctor --hooks. Receipts confirm observed callbacks, not compatibility with versions never exercised.' }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const report = await hookDoctor(); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1 }
  catch { console.error('hook receipts unavailable'); process.exitCode = 2 }
}
