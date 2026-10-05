#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { readEvents } from './event-ledger.mjs'
import { HOOK_NAMES, receiptPath } from './context-hook.mjs'

export async function hookDoctor({ env = process.env, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000, sessionId } = {}) {
  const { fingerprint } = await import('./event-ledger.mjs')
  const events = await readEvents(receiptPath(env))
  const session = sessionId === undefined ? undefined : fingerprint(sessionId)
  const hooks = HOOK_NAMES.map(hook => {
    const observed = events.filter(e => e.kind === 'hook-fired' && e.hook === hook && e.at <= now && now - e.at <= maxAgeMs && (session === undefined || e.fingerprint === session))
    return { hook, state: observed.length ? 'observed' : 'unverified', lastAt: observed.at(-1)?.at ?? null }
  })
  return { v: 1, ok: hooks.every(h => h.state === 'observed'), hooks,
    next: 'Use one Claude Code session to start, run Bash, compact and stop a teammate; then repeat doctor --hooks. Receipts confirm observed callbacks, not compatibility with versions never exercised.' }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const report = await hookDoctor(); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1 }
  catch { console.error('hook receipts unavailable'); process.exitCode = 2 }
}
