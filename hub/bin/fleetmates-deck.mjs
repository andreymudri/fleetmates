#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { setupPaths } from '../server/setup/paths.mjs'
import { deckHookCommand, readSettings, transformHooks, writeSettings } from '../server/setup/hooks.mjs'
import { UNIT_NAMES, renderUnit } from '../server/setup/units.mjs'
import { doctor, serviceProbe, status } from '../server/setup/doctor.mjs'
import { createServiceManager } from '../server/setup/service.mjs'
import { ensurePrivateDir, openNoFollowSync } from '../platform/index.mjs'
import { initChecks } from '../server/setup/wait.mjs'
import { openInBrowser } from '../server/setup/browser.mjs'
import { redact } from '../server/approvals/audit.mjs'
import { exportMisses } from '../server/ask/export-misses.mjs'
import { parsePublicOrigin } from '../server/http/auth.mjs'
import { checkPassphrase, hashPassphrase, writeRemotePass } from '../server/http/remote-pass.mjs'

const hub = fileURLToPath(new URL('..', import.meta.url))
const paths = setupPaths()
const command = deckHookCommand(process.execPath, paths.hook)
const args = process.argv.slice(2)
const USAGE = 'usage: fleetmates-deck init [--dry-run] [--rotate-token] | doctor | status | open | start | stop | uninstall-hooks | remote-access --public-origin <url> | --off | remote-pass | audit [--repo <name>] [--since <YYYY-MM-DD>] | export-misses [--kind retrieval|all] [--out <file>]'
// The user's tiers.json (07-approvals 4.1): created by init only when missing, with the schema copied beside it.
const tiersFile = path.join(paths.config, 'tiers.json')
const tiersSchema = path.join(paths.config, 'tiers.schema.json')
const tiersStub = `${JSON.stringify({ $schema: './tiers.schema.json', version: 1, extends: 'default', disable: [], entries: [] }, null, 2)}\n`

// The deckd and web services through the platform's service manager (systemd, launchd or detached processes).
// Built on first use, so commands that do not touch the services work on a platform without a service manager.
let manager = null
function services() {
  manager ??= createServiceManager({ paths, hubPath: hub, probe: serviceProbe(paths) })
  return manager
}

// Create a private directory: an existing one is narrowed to 0700 first, as before, and then ensurePrivateDir
// refuses it on POSIX when another user owns it or it still has a group or world bit.
async function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  await ensurePrivateDir(dir)
}

function writeIfMissing(file, content, mode = 0o600) {
  try { fs.writeFileSync(file, content, { flag: 'wx', mode }); return true } catch (error) { if (error.code === 'EEXIST') return false; throw error }
}

async function verifyListener(port, token) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid deck port')
  const nonce = randomBytes(24).toString('base64url')
  const expected = createHmac('sha256', token).update(`fleetmates-deck-open:${port}:${nonce}`).digest()
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
  // The installed hook reads its version from ../package.json, so the share directory carries only the hub version.
  const versionFile = path.join(paths.share, 'package.json')
  const versionContent = `${JSON.stringify({ version: JSON.parse(fs.readFileSync(path.join(hub, 'package.json'), 'utf8')).version })}\n`
  let versionChanged = true
  try { versionChanged = fs.readFileSync(versionFile, 'utf8') !== versionContent } catch (error) { if (error.code !== 'ENOENT') throw error }
  // systemd units are compared for the dry run; the service adapter writes them.
  const unitChanges = services().kind !== 'systemd' ? [] : UNIT_NAMES.map(name => {
    const content = renderUnit(name, process.execPath, hub)
    let changed = true
    try { changed = fs.readFileSync(path.join(paths.units, name), 'utf8') !== content } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { name, content, changed }
  })
  if (dryRun) {
    process.stdout.write(`directories: ${paths.config}, ${paths.state}, ${paths.share}\n`)
    process.stdout.write(`hook script: ${paths.hook}\n`)
    process.stdout.write(`hook version: ${versionFile} (${versionChanged ? 'would write' : 'unchanged'})\n`)
    process.stdout.write(`settings: ${changes ? 'would update' : 'unchanged'}\n`)
    process.stdout.write(`token: ${rotateToken ? 'would rotate' : 'would create if missing'}\n`)
    process.stdout.write(`tiers: ${tiersFile} (${fs.existsSync(tiersFile) ? 'unchanged' : 'would create'})\n`)
    for (const unit of unitChanges) process.stdout.write(`${unit.name}: ${unit.changed ? 'would write' : 'unchanged'}\n`)
    if (services().kind !== 'systemd') process.stdout.write(`services: would install (${services().kind})\n`)
    return
  }
  for (const dir of [paths.config, paths.state, paths.spool, paths.logs, paths.share, path.dirname(paths.hook)]) await privateDir(dir)
  if (!fs.existsSync(paths.hook) || !fs.readFileSync(paths.hook).equals(source)) fs.writeFileSync(paths.hook, source, { mode: 0o600 })
  fs.chmodSync(paths.hook, 0o600)
  if (versionChanged) fs.writeFileSync(versionFile, versionContent, { mode: 0o600 })
  fs.chmodSync(versionFile, 0o600)
  const backup = writeSettings(paths.settings, current, merged)
  if (backup) process.stdout.write(`settings backup: ${backup}\n`)
  if (rotateToken) {
    const temp = `${paths.token}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
    fs.renameSync(temp, paths.token)
  } else writeIfMissing(paths.token, `${randomBytes(32).toString('base64url')}\n`)
  fs.chmodSync(paths.token, 0o600)
  if (writeIfMissing(tiersFile, tiersStub)) process.stdout.write(`tiers: ${tiersFile} created\n`)
  fs.copyFileSync(path.join(hub, 'server/approvals/tiers.schema.json'), tiersSchema)
  fs.chmodSync(tiersSchema, 0o600)
  await services().install()
  process.stdout.write('deckd remains running if it was already active\n')
  const checks = await initChecks(paths, command, { service: services() })
  for (const check of checks) process.stdout.write(`${check.id}: ${check.state} (${check.detail})\n`)
  if (checks.find(check => check.id === 'hooks')?.state !== 'ok') process.exitCode = 1
}

/**
 * `audit [--repo <name>] [--since <YYYY-MM-DD>]`: the approvals audit (`approval_audit`) and the rule audit
 * (`rule_audit`) oldest first, one row per line, read from the deck database without changing it. Summaries are
 * redacted again on output (08-security 4.10). `--since` is local midnight of that day.
 */
async function audit(rest) {
  let repo = null
  let since = 0
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1]
    if (rest[i] === '--repo' && typeof value === 'string' && value) repo = value
    else if (rest[i] === '--since' && /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
      const [year, month, day] = value.split('-').map(Number)
      const date = new Date(year, month - 1, day)
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error(USAGE)
      since = date.getTime()
    } else throw new Error(USAGE)
  }
  const file = path.join(paths.state, 'deck.db')
  if (!fs.existsSync(file)) throw new Error('no deck database yet; start the deck first')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const names = new Map(db.prepare('SELECT id, name FROM repos').all().map(row => [row.id, row.name]))
    const repoName = id => id === null || id === undefined ? '-' : names.get(id) ?? path.basename(id)
    const keep = row => !repo || (row.repo_id !== null && repoName(row.repo_id) === repo)
    const shown = value => value === null || value === undefined ? '-' : String(value)
    const rows = [
      ...db.prepare('SELECT * FROM approval_audit WHERE at >= ? ORDER BY at, id').all(since).filter(keep).map(row => ({ at: row.at, order: 0, id: row.id,
        line: `${row.kind} repo=${repoName(row.repo_id)} tier=${shown(row.tier)} via=${shown(row.via)} choice=${shown(row.choice)} summary=${JSON.stringify(redact(row.summary) ?? '')}` })),
      ...db.prepare('SELECT * FROM rule_audit WHERE at >= ? ORDER BY at, id').all(since).filter(keep).map(row => ({ at: row.at, order: 1, id: row.id,
        line: `rule_${row.action} repo=${repoName(row.repo_id)} pattern=${JSON.stringify(redact(row.pattern) ?? '')} actor=${row.actor}` }))
    ].sort((a, b) => a.at - b.at || a.order - b.order || a.id - b.id)
    for (const row of rows) process.stdout.write(`${new Date(row.at).toISOString()} ${row.line}\n`)
  } finally { db.close() }
}

/**
 * `remote-access --public-origin <url>` and `--off`: the opt-in public origin of the Tailscale tunnel, kept in
 * `config.json` beside the port, since it is ordinary configuration. The passphrase is a secret and never goes
 * in this file; it lives hashed in its own 0600 file (`remote-pass`).
 */
async function remoteAccess(rest) {
  const value = rest[0] === '--off' && rest.length === 1 ? null : rest[0] === '--public-origin' && rest.length === 2 ? rest[1] : undefined
  if (value === undefined) throw new Error(USAGE)
  // Validated here so a typo fails at the terminal rather than at the next server start.
  const parsed = parsePublicOrigin(value)
  await privateDir(paths.config)
  const file = path.join(paths.config, 'config.json')
  let config = {}
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file} is not a JSON object`)
  if (parsed) config.publicOrigin = parsed.origin
  else delete config.publicOrigin
  // A random name created with O_EXCL through openNoFollowSync, as platform/index.mjs publishes a key file: a
  // predictable temporary name can be waiting for the write.
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const fd = openNoFollowSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, { mode: 0o600 })
    try {
      fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    fs.renameSync(temp, file)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  process.stdout.write(parsed ? `public origin: ${parsed.origin}\n` : 'public origin: removed\n')
  process.stdout.write('restart the web server for it to take effect: systemctl --user restart fleetmates-deck\n')
}

/**
 * Read passphrases from stdin without echoing them, so the passphrase never reaches the terminal or the
 * scrollback. One reader for the whole prompt sequence: a piped stdin delivers its lines to the same interface.
 */
async function secretReader() {
  const { createInterface } = await import('node:readline')
  const { Writable } = await import('node:stream')
  if (!process.stdin.isTTY) {
    // A piped stdin is read whole first: its lines arrive together, and a second prompt would miss them.
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    // CRLF too: `type pass.txt | fleetmates-deck remote-pass` on Windows ends every line with a carriage return,
    // and a passphrase stored with a trailing \r would match here and never match what a phone types.
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
    let next = 0
    return { read: async () => lines[next++] ?? '', close: () => {} }
  }
  const sink = new Writable({ write(chunk, encoding, done) { done() } })
  const lines = createInterface({ input: process.stdin, output: sink, terminal: true })
  return {
    read(prompt) {
      process.stdout.write(prompt)
      return new Promise(resolve => lines.question('', answer => {
        process.stdout.write('\n')
        resolve(answer)
      }))
    },
    close: () => lines.close()
  }
}

/**
 * `remote-pass`: set the remote access passphrase. It is read from stdin, never from argv, which `ps` and the
 * shell history would both show, and stored as a scrypt hash in a private 0600 file beside the deck token.
 */
async function remotePass() {
  const reader = await secretReader()
  let passphrase
  try {
    passphrase = checkPassphrase(await reader.read('remote access passphrase: '))
    if (await reader.read('repeat it: ') !== passphrase) throw new Error('the two passphrases differ')
  } finally { reader.close() }
  await privateDir(paths.state)
  const file = path.join(paths.state, 'remote-pass.json')
  writeRemotePass(file, await hashPassphrase(passphrase))
  process.stdout.write(`remote access passphrase: stored in ${file}\n`)
}

async function main() {
  const [name, ...rest] = args
  if (name === 'export-misses') {
    let kind = 'retrieval', out = null
    for (let i = 0; i < rest.length; i += 2) {
      if (!rest[i + 1] || !['--kind', '--out'].includes(rest[i])) { process.stderr.write(`${USAGE}\n`); process.exitCode = 2; return }
      if (rest[i] === '--kind') kind = rest[i + 1]
      else out = rest[i + 1]
    }
    if (!['retrieval', 'all'].includes(kind)) { process.stderr.write(`${USAGE}\n`); process.exitCode = 2; return }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(paths.state, 'deck.db'), { readOnly: true })
    try {
      const lines = exportMisses({ all: sql => db.prepare(sql).all() }, { kind })
      if (out) {
        const fd = openNoFollowSync(out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, { mode: 0o600 })
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, lines) } finally { fs.closeSync(fd) }
      } else process.stdout.write(lines)
    } finally { db.close() }
    return
  }
  if (name === 'audit') return audit(rest)
  if (name === 'remote-access') return remoteAccess(rest)
  if (name === 'remote-pass' && rest.length === 0) return remotePass()
  if (name === 'init' && rest.every(arg => ['--dry-run', '--rotate-token'].includes(arg))) return init(rest.includes('--dry-run'), rest.includes('--rotate-token'))
  if (name === 'uninstall-hooks' && rest.length === 0) {
    const current = readSettings(paths.settings)
    const backup = writeSettings(paths.settings, current, transformHooks(current.value, command, true))
    process.stdout.write(backup ? `settings backup: ${backup}\n` : 'hooks unchanged\n')
    return
  }
  if (name === 'doctor' && rest.length === 0) {
    const checks = await doctor(paths, command, { service: services() })
    for (const check of checks) process.stdout.write(`${check.id}: ${check.state} (${check.detail})\n`)
    if (checks.find(check => check.id === 'hooks')?.state !== 'ok') process.exitCode = 1
    return
  }
  if (name === 'status' && rest.length === 0) { process.stdout.write(`${JSON.stringify(await status(paths, command, { service: services() }), null, 2)}\n`); return }
  if (name === 'start' && rest.length === 0) {
    for (const service of ['deckd', 'web']) await services().start(service)
    return
  }
  if (name === 'stop' && rest.length === 0) {
    for (const service of ['web', 'deckd']) await services().stop(service)
    return
  }
  if (name === 'open' && rest.length === 0) {
    if (!fs.existsSync(path.join(hub, 'server/main.mjs'))) throw new Error('web server entrypoint is not installed')
    if (!fs.lstatSync(paths.state).isDirectory()) throw new Error('deck state directory is not a directory')
    await privateDir(paths.state)
    const token = fs.readFileSync(paths.token, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid deck token')
    let port = 47800
    try { port = JSON.parse(fs.readFileSync(path.join(paths.config, 'config.json'), 'utf8')).port || port } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (process.env.DECK_PORT !== undefined) {
      if (!/^[1-9][0-9]{0,4}$/.test(process.env.DECK_PORT)) throw new Error('invalid DECK_PORT')
      port = Number(process.env.DECK_PORT)
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid deck port')
    await services().start('web')
    await verifyListener(port, token)
    const url = `http://127.0.0.1:${port}/#token=${token}`
    const bootstrap = path.join(paths.state, 'open.html')
    const temp = path.join(paths.state, `.open-${randomBytes(12).toString('hex')}.tmp`)
    try {
      fs.writeFileSync(temp, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>location.replace(${JSON.stringify(url)})</script>\n`, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temp, bootstrap)
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
    if (!await openInBrowser(bootstrap)) throw new Error(`could not open a browser; open this file in your web browser: ${bootstrap}`)
    return
  }
  throw new Error(USAGE)
}

main().catch(error => { process.stderr.write(`fleetmates-deck: ${error.message}\n`); process.exitCode = 1 })
