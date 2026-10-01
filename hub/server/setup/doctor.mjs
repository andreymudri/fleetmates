import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { createLineDecoder, encode, PROTO } from '../../deckd/protocol.mjs'
import { SOCKET_NAME } from '../adapters/scribed.mjs'
import { hooksInstalled, readSettings } from './hooks.mjs'

/** The Claude Code version the newest hook fixture set covers (docs/deck/09-testing.md section 4). */
export const TESTED_CLAUDE_CODE = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).fleetmatesDeck.testedClaudeCode

/** Compare two x.y.z versions numerically: negative, zero or positive. */
function compareVersions(a, b) {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/**
 * Check 1. Equal to the tested version is ok; newer is a non-blocking warning (SM-O18 default:
 * warn only); older or not found is failed. None of them block (only the hooks check does, D-63).
 */
function claudeCheck(version) {
  const tested = TESTED_CLAUDE_CODE
  if (!version) return { id: 'claude', state: 'failed', blocking: false, detail: `Claude Code unavailable; tested ${tested}` }
  const order = compareVersions(version, tested)
  if (order === 0) return { id: 'claude', state: 'ok', blocking: false, detail: `Claude Code ${version}; tested ${tested}` }
  if (order > 0) return { id: 'claude', state: 'warn', blocking: false, detail: `Claude Code ${version} is newer than this deck was tested with (${tested})` }
  return { id: 'claude', state: 'failed', blocking: false, detail: `Claude Code ${version}; tested ${tested}` }
}

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

/** A variable name; any other `loginEnvNames` entry is left out, so no value can be printed. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Detail of a running deckd's check from its hello answer (OPS-O2): the login-environment
 * variable names deckd adds to launched sessions, sorted, never their values. A proto 1 deckd
 * does not send them.
 */
function deckdDetail(hello) {
  if (hello?.proto === 1) return 'deckd running; login env names need deckd 0.2.0'
  const names = Array.isArray(hello?.loginEnvNames) ? hello.loginEnvNames.filter(name => typeof name === 'string' && ENV_NAME.test(name)).sort() : []
  return names.length ? `login env adds ${names.length} names: ${names.join(', ')}` : 'deckd running'
}

/** Run the six terminal setup checks without changing local state. */
export async function doctor(paths, command, { run = probe } = {}) {
  const claude = run('claude', ['--version'])
  const version = claude.status === 0 ? claude.stdout.match(/\d+\.\d+\.\d+/)?.[0] : null
  const checks = [claudeCheck(version)]
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
  let hello = null
  if (unit.status === 0 && paths.runtime) {
    try {
      hello = await probeDeckd(paths)
      socket = true
    } catch {}
  }
  checks.push({ id: 'deckd', state: unit.status === 0 && socket ? 'ok' : 'failed', blocking: false, detail: unit.status === 0 && socket ? deckdDetail(hello) : 'deckd unavailable' })
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
  return { units, hooks, socket, livePtys, claudeVersion, testedClaudeVersion: TESTED_CLAUDE_CODE }
}
