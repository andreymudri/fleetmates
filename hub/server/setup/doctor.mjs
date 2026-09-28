import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { connectDeckd } from '../../deckd/client.mjs'
import { hooksInstalled, readSettings } from './hooks.mjs'

function probe(file, args, timeout = 2000) {
  return spawnSync(file, args, { encoding: 'utf8', timeout, env: process.env })
}

/** Run the six terminal setup checks without changing local state. */
export async function doctor(paths, command, { run = probe } = {}) {
  const claude = run('claude', ['--version'])
  const version = claude.status === 0 ? claude.stdout.match(/\d+\.\d+\.\d+/)?.[0] : null
  const checks = [{ id: 'claude', state: version === '2.1.282' ? 'ok' : 'failed', blocking: false, detail: version ? `Claude Code ${version}; tested 2.1.282` : 'Claude Code unavailable; tested 2.1.282' }]
  let installed = false
  try { installed = hooksInstalled(readSettings(paths.settings).value, command) } catch {}
  checks.push({ id: 'hooks', state: installed ? 'ok' : 'failed', blocking: true, detail: installed ? 'Observation hooks installed' : 'Observation hooks missing' })
  const unit = run('systemctl', ['--user', 'is-active', 'fleetmates-deckd.service'])
  let socket = false
  if (unit.status === 0 && paths.runtime) {
    try {
      const client = await connectDeckd({ runtimeDir: path.dirname(paths.runtime), kind: 'terminal' })
      client.close()
      socket = true
    } catch {}
  }
  checks.push({ id: 'deckd', state: unit.status === 0 && socket ? 'ok' : 'failed', blocking: false, detail: unit.status === 0 && socket ? 'deckd running' : 'deckd unavailable' })
  checks.push({ id: 'vault', state: 'optional_skipped', blocking: false, detail: 'vault-mcp not checked by terminal setup' })
  checks.push({ id: 'scribed', state: paths.runtime && fs.existsSync(path.join(paths.runtime, 'scribed.sock')) ? 'ok' : 'optional_skipped', blocking: false, detail: 'scribed socket optional' })
  checks.push({ id: 'notify', state: 'pending', blocking: false, detail: 'Send a test ping from Settings' })
  return checks
}

/** Read service and hook status for the terminal. */
export async function status(paths, command, { run = probe } = {}) {
  const units = ['fleetmates-deckd.service', 'fleetmates-deck.service'].map(name => ({ name, active: run('systemctl', ['--user', 'is-active', name]).status === 0 }))
  let hooks = false
  try { hooks = hooksInstalled(readSettings(paths.settings).value, command) } catch {}
  const socket = paths.runtime ? fs.existsSync(path.join(paths.runtime, 'deckd.sock')) : false
  const claude = run('claude', ['--version'])
  const claudeVersion = claude.status === 0 ? claude.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null : null
  let livePtys = 0
  if (socket) {
    try {
      const client = await connectDeckd({ runtimeDir: path.dirname(paths.runtime), kind: 'terminal' })
      try { livePtys = (await client.request('list')).ptys.length } finally { client.close() }
    } catch {}
  }
  return { units, hooks, socket, livePtys, claudeVersion, testedClaudeVersion: '2.1.282' }
}
