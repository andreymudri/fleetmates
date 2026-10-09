import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLineDecoder, encode, PROTO } from '../../deckd/protocol.mjs'
import { commandSpawn, isPipe, resolveCommand } from '../../platform/index.mjs'
import { SOCKET_NAME } from '../adapters/scribed.mjs'
import { hooksInstalled, readSettings } from './hooks.mjs'
import { createServiceManager } from './service.mjs'
import { LAUNCHD_LABELS, UNIT_NAMES } from './units.mjs'

const HUB = fileURLToPath(new URL('../..', import.meta.url))
const SERVICES = ['deckd', 'web']

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

function probe(file, args, options = {}) {
  return spawnSync(file, args, { encoding: 'utf8', timeout: 2000, env: process.env, ...options })
}

/** Resolve true once `target` (a socket or pipe path, or net connect options) accepts a connection, false on any error or after `timeout` ms. */
export function connectOnce(target, timeout = 500) {
  if (!target) return Promise.resolve(false)
  return new Promise(resolve => {
    const socket = net.createConnection(target)
    const done = ok => { clearTimeout(timer); socket.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeout)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** The web port: DECK_PORT when valid, else config.json `port`, else 47800. Never throws. */
export function webPort(paths, env = process.env) {
  if (/^[1-9][0-9]{0,4}$/.test(env.DECK_PORT ?? '') && Number(env.DECK_PORT) <= 65535) return Number(env.DECK_PORT)
  try {
    const port = JSON.parse(fs.readFileSync(path.join(paths.config, 'config.json'), 'utf8')).port
    if (Number.isInteger(port) && port > 0 && port < 65536) return port
  } catch {}
  return 47800
}

/** Resolve true when the web server answers any HTTP request on loopback `port` within `timeout` ms. */
function httpOnce(port, timeout = 500) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', agent: false, timeout }, res => { res.resume(); resolve(true) })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(false))
  })
}

/** The liveness probe the service adapter uses where the service manager cannot answer (launchd, detached). */
export function serviceProbe(paths, env = process.env) {
  return service => service === 'deckd' ? connectOnce(paths.endpoints?.deckd) : httpOnce(webPort(paths, env))
}

/**
 * The service adapter doctor, status and init use: `service` when given, else one built for `platform` whose
 * commands go through the synchronous `run(file, args)` (spawnSync-shaped: `{ status, stdout, stderr }`).
 */
export function deckService(paths, { platform = process.platform, run = probe, service, env = process.env } = {}) {
  if (service) return service
  return createServiceManager({
    platform, paths, hubPath: HUB, env,
    run: async (file, args) => {
      const result = run(file, args)
      return { code: result?.status ?? null, stdout: result?.stdout ?? '', stderr: result?.stderr ?? '' }
    },
    probe: serviceProbe(paths, env)
  })
}

/** The name `status` reports for `service` under the adapter `kind`. */
function serviceName(kind, service) {
  if (kind === 'systemd') return UNIT_NAMES[SERVICES.indexOf(service)]
  if (kind === 'launchd') return LAUNCHD_LABELS[service]
  return service
}

/** `claude --version` through resolveCommand and commandSpawn; the x.y.z version or null. */
function claudeVersion(run, { platform, env, exists, readFile }) {
  let spawn
  try {
    const file = resolveCommand('claude', { env, platform, ...(exists ? { exists } : {}) })
    spawn = commandSpawn(file, ['--version'], { platform, env, ...(readFile ? { readFile } : {}) })
  } catch { return null }
  const result = run(spawn.file, spawn.args, spawn.options)
  return result?.status === 0 ? String(result.stdout ?? '').match(/\d+\.\d+\.\d+/)?.[0] ?? null : null
}

function probeDeckd(paths, list = false) {
  return new Promise((resolve, reject) => {
    if (!paths.endpoints?.deckd) { reject(new Error('no deckd endpoint')); return }
    const socket = net.createConnection(paths.endpoints.deckd)
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

/**
 * Run the six terminal setup checks without changing local state. Service state comes from the service adapter
 * (`service`, or one built for `platform` over `run`); claude runs through resolveCommand and commandSpawn.
 */
export async function doctor(paths, command, { run = probe, platform = process.platform, env = process.env, service, exists, readFile } = {}) {
  const checks = [claudeCheck(claudeVersion(run, { platform, env, exists, readFile }))]
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
  const active = await deckService(paths, { platform, run, service, env }).isActive('deckd')
  let socket = false
  let hello = null
  if (active) {
    try {
      hello = await probeDeckd(paths)
      socket = true
    } catch {}
  }
  checks.push({ id: 'deckd', state: active && socket ? 'ok' : 'failed', blocking: false, detail: active && socket ? deckdDetail(hello) : 'deckd unavailable' })
  checks.push({ id: 'vault', state: 'optional_skipped', blocking: false, detail: 'vault-mcp not checked by terminal setup' })
  if (platform === 'linux') checks.push({ id: 'scribed', state: paths.runtime && fs.existsSync(path.join(path.dirname(paths.runtime), SOCKET_NAME)) ? 'ok' : 'optional_skipped', blocking: false, detail: 'scribed socket optional' })
  else checks.push({ id: 'scribed', state: 'optional_skipped', blocking: false, detail: `unsupported on ${platform}` })
  if (platform === 'win32') checks.push({ id: 'notify', state: 'optional_skipped', blocking: false, detail: 'in-tab only on win32' })
  else checks.push({ id: 'notify', state: 'pending', blocking: false, detail: 'Send a test ping from Settings' })
  return checks
}

/** Read service and hook status for the terminal. */
export async function status(paths, command, { run = probe, platform = process.platform, env = process.env, service, exists, readFile } = {}) {
  const manager = deckService(paths, { platform, run, service, env })
  const units = []
  for (const name of SERVICES) units.push({ name: serviceName(manager.kind, name), active: await manager.isActive(name) })
  let hooks = false
  try { hooks = hooksInstalled(readSettings(paths.settings).value, command) } catch {}
  const deckd = paths.endpoints?.deckd
  const socket = !deckd ? false : isPipe(deckd) ? await connectOnce(deckd) : fs.existsSync(deckd)
  const version = claudeVersion(run, { platform, env, exists, readFile })
  let livePtys = 0
  if (socket) {
    try {
      livePtys = (await probeDeckd(paths, true)).ptys.length
    } catch {}
  }
  return { units, hooks, socket, livePtys, claudeVersion: version, testedClaudeVersion: TESTED_CLAUDE_CODE }
}
