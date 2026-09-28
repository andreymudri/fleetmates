#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { setupPaths } from '../server/setup/paths.mjs'
import { readSettings, transformHooks, writeSettings } from '../server/setup/hooks.mjs'
import { UNIT_NAMES, renderUnit, writeUnit } from '../server/setup/units.mjs'
import { doctor, status } from '../server/setup/doctor.mjs'

const hub = fileURLToPath(new URL('..', import.meta.url))
const paths = setupPaths()
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const command = `${shellQuote(process.execPath)} ${shellQuote(paths.hook)}`
const args = process.argv.slice(2)

function run(file, argv) {
  const result = spawnSync(file, argv, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) throw new Error(`${file} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`)
  return result
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

function writeIfMissing(file, content, mode = 0o600) {
  try { fs.writeFileSync(file, content, { flag: 'wx', mode }); return true } catch (error) { if (error.code === 'EEXIST') return false; throw error }
}

async function verifyListener(port, token) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid deck port')
  const nonce = randomBytes(24).toString('base64url')
  const expected = createHmac('sha256', token).update(`fleetmates-deck-open:${nonce}`).digest()
  const deadline = Date.now() + 3000
  let body
  for (;;) {
    try {
      body = await new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: `/.well-known/fleetmates-deck/identity?nonce=${nonce}`, timeout: Math.max(1, Math.min(500, deadline - Date.now())), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), agent: false }, res => {
          if (res.statusCode !== 200 || res.headers['content-type']?.split(';')[0] !== 'application/json') {
            res.resume()
            reject(new Error('deck identity endpoint unavailable'))
            return
          }
          let content = ''
          res.on('data', chunk => {
            content += chunk
            if (content.length > 1024) req.destroy(new Error('deck identity response too large'))
          })
          res.on('end', () => resolve(content))
        })
        req.on('timeout', () => req.destroy(Object.assign(new Error('deck identity timed out'), { code: 'ETIMEDOUT' })))
        req.on('error', reject)
      })
      break
    } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code) || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
    }
  }
  let reply
  try { reply = JSON.parse(body) } catch { throw new Error('invalid deck identity response') }
  if (reply?.nonce !== nonce || typeof reply.mac !== 'string' || !/^[a-f0-9]{64}$/.test(reply.mac)) throw new Error('deck identity proof missing')
  if (!timingSafeEqual(Buffer.from(reply.mac, 'hex'), expected)) throw new Error('deck identity proof failed')
}

async function init(dryRun, rotateToken) {
  const current = readSettings(paths.settings)
  const merged = transformHooks(current.value, command)
  const changes = JSON.stringify(current.value) !== JSON.stringify(merged)
  const hookSource = path.join(hub, 'hook/deck-hook.mjs')
  const source = fs.readFileSync(hookSource)
  const unitChanges = UNIT_NAMES.map(name => {
    const content = renderUnit(name, process.execPath, hub)
    let changed = true
    try { changed = fs.readFileSync(path.join(paths.units, name), 'utf8') !== content } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { name, content, changed }
  })
  if (dryRun) {
    process.stdout.write(`directories: ${paths.config}, ${paths.state}, ${paths.share}\n`)
    process.stdout.write(`hook script: ${paths.hook}\n`)
    process.stdout.write(`settings: ${changes ? 'would update' : 'unchanged'}\n`)
    process.stdout.write(`token: ${rotateToken ? 'would rotate' : 'would create if missing'}\n`)
    for (const unit of unitChanges) process.stdout.write(`${unit.name}: ${unit.changed ? 'would write' : 'unchanged'}\n`)
    return
  }
  for (const dir of [paths.config, paths.state, paths.spool, paths.logs, paths.share, path.dirname(paths.hook)]) privateDir(dir)
  if (!fs.existsSync(paths.hook) || !fs.readFileSync(paths.hook).equals(source)) fs.writeFileSync(paths.hook, source, { mode: 0o600 })
  fs.chmodSync(paths.hook, 0o600)
  const backup = writeSettings(paths.settings, current, merged)
  if (backup) process.stdout.write(`settings backup: ${backup}\n`)
  if (rotateToken) {
    const temp = `${paths.token}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
    fs.renameSync(temp, paths.token)
  } else writeIfMissing(paths.token, `${randomBytes(32).toString('base64url')}\n`)
  fs.chmodSync(paths.token, 0o600)
  let changedUnit = false
  let webUnitChanged = false
  for (const unit of unitChanges) {
    const changed = writeUnit(path.join(paths.units, unit.name), unit.content)
    changedUnit = changed || changedUnit
    if (unit.name === 'fleetmates-deck.service') webUnitChanged = changed
  }
  if (changedUnit) run('systemctl', ['--user', 'daemon-reload'])
  if (webUnitChanged) run('systemctl', ['--user', 'try-restart', 'fleetmates-deck.service'])
  run('systemctl', ['--user', 'enable', '--now', ...UNIT_NAMES])
  process.stdout.write('deckd remains running if it was already active\n')
  const checks = await doctor(paths, command)
  for (const check of checks) process.stdout.write(`${check.id}: ${check.state} (${check.detail})\n`)
  if (checks.find(check => check.id === 'hooks')?.state !== 'ok') process.exitCode = 1
}

async function main() {
  const [name, ...rest] = args
  if (name === 'init' && rest.every(arg => ['--dry-run', '--rotate-token'].includes(arg))) return init(rest.includes('--dry-run'), rest.includes('--rotate-token'))
  if (name === 'uninstall-hooks' && rest.length === 0) {
    const current = readSettings(paths.settings)
    const backup = writeSettings(paths.settings, current, transformHooks(current.value, command, true))
    process.stdout.write(backup ? `settings backup: ${backup}\n` : 'hooks unchanged\n')
    return
  }
  if (name === 'doctor' && rest.length === 0) {
    const checks = await doctor(paths, command)
    for (const check of checks) process.stdout.write(`${check.id}: ${check.state} (${check.detail})\n`)
    if (checks.find(check => check.id === 'hooks')?.state !== 'ok') process.exitCode = 1
    return
  }
  if (name === 'status' && rest.length === 0) { process.stdout.write(`${JSON.stringify(await status(paths, command), null, 2)}\n`); return }
  if (name === 'open' && rest.length === 0) {
    if (!fs.lstatSync(paths.state).isDirectory()) throw new Error('deck state directory is not a directory')
    fs.chmodSync(paths.state, 0o700)
    const token = fs.readFileSync(paths.token, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid deck token')
    let port = 47800
    try { port = JSON.parse(fs.readFileSync(path.join(paths.config, 'config.json'), 'utf8')).port || port } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (process.env.DECK_PORT !== undefined) {
      if (!/^[1-9][0-9]{0,4}$/.test(process.env.DECK_PORT)) throw new Error('invalid DECK_PORT')
      port = Number(process.env.DECK_PORT)
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid deck port')
    run('systemctl', ['--user', 'start', 'fleetmates-deck.service'])
    await verifyListener(port, token)
    const url = `http://127.0.0.1:${port}/#token=${token}`
    const bootstrap = path.join(paths.state, 'open.html')
    const temp = path.join(paths.state, `.open-${randomBytes(12).toString('hex')}.tmp`)
    try {
      fs.writeFileSync(temp, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>location.replace(${JSON.stringify(url)})</script>\n`, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temp, bootstrap)
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
    const result = spawnSync('xdg-open', [bootstrap], { stdio: 'ignore', timeout: 10000 })
    if (result.error || result.status !== 0) throw new Error('could not open browser')
    return
  }
  throw new Error('usage: fleetmates-deck init [--dry-run] [--rotate-token] | doctor | status | open | uninstall-hooks')
}

main().catch(error => { process.stderr.write(`fleetmates-deck: ${error.message}\n`); process.exitCode = 1 })
