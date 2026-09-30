import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { createLineDecoder, encode, PROTO } from '../../deckd/protocol.mjs'
import { SOCKET_NAME } from '../adapters/scribed.mjs'
import { hooksInstalled, readSettings } from './hooks.mjs'

function probe(file, args, timeout = 2000) {
  return spawnSync(file, args, { encoding: 'utf8', timeout, env: process.env })
}

function probeDeckd(paths, list = false) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(paths.runtime, 'deckd.sock'))
    let settled = false
    let expectedId = 1
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error('deckd probe timed out')), 2000)
    socket.once('connect', () => {
      socket.write(encode({ id: 1, op: 'hello', proto: PROTO, client: { kind: 'terminal', pid: process.pid } }))
    })
    socket.on('data', createLineDecoder(message => {
      if (settled || message?.id !== expectedId) return
      if (message.ok !== true) {
        finish(new Error('deckd probe refused'))
      } else if (expectedId === 1 && list) {
        expectedId = 2
        socket.write(encode({ id: 2, op: 'list' }))
      } else {
        finish(null, message)
      }
    }, () => finish(new Error('invalid deckd response'))))
    socket.once('error', error => finish(error))
    socket.once('close', () => finish(new Error('deckd probe closed')))
  })
}

/** Run the six terminal setup checks without changing local state. */
export async function doctor(paths, command, { run = probe } = {}) {
  const claude = run('claude', ['--version'])
  const version = claude.status === 0 ? claude.stdout.match(/\d+\.\d+\.\d+/)?.[0] : null
  const checks = [{ id: 'claude', state: version === '2.1.282' ? 'ok' : 'failed', blocking: false, detail: version ? `Claude Code ${version}; tested 2.1.282` : 'Claude Code unavailable; tested 2.1.282' }]
  let configured = false
  try { configured = hooksInstalled(readSettings(paths.settings).value, command) } catch {}
  let usable = false
  if (configured) {
    try {
      usable = fs.statSync(paths.hook).isFile()
      if (usable) fs.accessSync(paths.hook, fs.constants.R_OK)
    } catch { usable = false }
  }
  checks.push({ id: 'hooks', state: configured && usable ? 'ok' : 'failed', blocking: true, detail: !configured ? 'Observation hooks missing' : usable ? 'Observation hooks installed' : 'Observation hook script missing or unreadable' })
  const unit = run('systemctl', ['--user', 'is-active', 'fleetmates-deckd.service'])
  let socket = false
  if (unit.status === 0 && paths.runtime) {
    try {
      await probeDeckd(paths)
      socket = true
    } catch {}
  }
  checks.push({ id: 'deckd', state: unit.status === 0 && socket ? 'ok' : 'failed', blocking: false, detail: unit.status === 0 && socket ? 'deckd running' : 'deckd unavailable' })
  checks.push({ id: 'vault', state: 'optional_skipped', blocking: false, detail: 'vault-mcp not checked by terminal setup' })
  checks.push({ id: 'scribed', state: paths.runtime && fs.existsSync(path.join(path.dirname(paths.runtime), SOCKET_NAME)) ? 'ok' : 'optional_skipped', blocking: false, detail: 'scribed socket optional' })
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
      livePtys = (await probeDeckd(paths, true)).ptys.length
    } catch {}
  }
  return { units, hooks, socket, livePtys, claudeVersion, testedClaudeVersion: '2.1.282' }
}
