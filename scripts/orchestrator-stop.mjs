#!/usr/bin/env node
import { readFileSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { discover, git, readBinding, planHash, lifecycleStatus } from './workflow-lifecycle.mjs'
import { appendEvent, fingerprint } from './event-ledger.mjs'
import { stopReceiptPath } from './context-hook.mjs'
import { printable } from './reviews.mjs'

export async function handleOrchestratorStop(input, { err = () => {}, execute = spawnSync } = {}) {
  if (input?.stop_hook_active === true || typeof input?.cwd !== 'string' || !input.cwd || typeof input.session_id !== 'string') return 0
  let repository
  try { repository = discover(input.cwd) } catch { return 0 }
  try {
    const binding = await readBinding(repository.common, input.session_id)
    if (!binding) return 0
    try { if (!lstatSync(path.join(repository.root, '.fleetmates', binding.run)).isDirectory()) return 0 }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error }
    if (binding.root !== repository.root || git(['symbolic-ref', '--quiet', 'HEAD'], input.cwd) !== binding.branch) throw new Error('Session binding does not match this repository and branch')
    const anchor = binding.version === 2 ? binding.anchor : git(['merge-base', binding.branch, `refs/heads/${binding.base}`], input.cwd)
    if (planHash(input.cwd, anchor, binding.plan) !== binding.planHash) throw new Error('Bound plan requirements changed; rebind with a new session')
    if (binding.version === 2 && planHash(input.cwd, binding.branch, binding.plan) !== binding.planHash) throw new Error('Current plan requirements changed; rebind with a new session')
    const status = lifecycleStatus(input.cwd, binding.run)
    if (status.state !== 'running') { err(`Run is ${status.state}; delivery is not verified complete`); return 0 }
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs')
    const result = execute(process.execPath, [cli, 'finish', '--run', binding.run, '--plan', binding.plan,
      '--base', binding.base, '--root', input.cwd, '--enforcement-only'],
    { cwd: input.cwd, encoding: 'utf8', timeout: 12000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.error || result.signal || !Number.isInteger(result.status)) throw new Error('Completion guard could not finish within its bounds')
    const output = String(result.stdout || '').slice(0, 16000)
    if (result.status === 1 || result.status === 4) {
      err(`Run has failed or unresolved enforcement obligations. Continue or explicitly suspend/abandon it.\n${output}`)
      return 2
    }
    if (result.status !== 0) throw new Error('Completion guard rejected its configuration')
    err(`Enforcement-only stop check passed; skipped commands and reviews are not completion evidence. This handler execution does not prove an actual graceful harness callback or full completion.\n${output}`)
    return 0
  } catch (error) { err(`Fleetmates Stop guard allowed stop: ${printable(error.message)}`); return 0 }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let input
  try { const body = readFileSync(0, 'utf8'); if (Buffer.byteLength(body) <= 1024 * 1024) input = JSON.parse(body) } catch { /* fail open */ }
  if (input && typeof input.session_id === 'string') {
    try { await appendEvent(stopReceiptPath(), { kind: 'hook-fired', hook: 'Stop', at: Date.now(), fingerprint: fingerprint(input.session_id) }) } catch { /* optional observation */ }
  }
  process.exitCode = await handleOrchestratorStop(input, { err: console.error })
}
