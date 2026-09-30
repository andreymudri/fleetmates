import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { createServer } from 'node:net'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { doctor, status } from '../../server/setup/doctor.mjs'
import { hooksInstalled, isDeckHook, readSettings, transformHooks, writeSettings } from '../../server/setup/hooks.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { renderUnit } from '../../server/setup/units.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const fixtures = path.join(hub, 'test/fixtures/settings')
const requiredHookEvents = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged',
  'PreCompact', 'PostCompact', 'WorktreeCreate', 'WorktreeRemove'
]

function sandbox(fixture = 'empty.json', { isolatedHub = false, webEntry = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'deck-setup-'))
  const home = path.join(root, 'home')
  const config = path.join(root, 'config')
  const state = path.join(root, 'state')
  const runtime = path.join(root, 'runtime')
  const bin = path.join(root, 'bin')
  const calls = path.join(root, 'calls')
  for (const dir of [home, config, state, runtime, bin, path.join(home, '.claude')]) mkdirSync(dir, { recursive: true })
  const settings = path.join(home, '.claude/settings.json')
  writeFileSync(settings, readFileSync(path.join(fixtures, fixture)))
  for (const name of ['systemctl', 'xdg-open', 'claude', 'notify-send']) {
    const file = path.join(bin, name)
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}:'"$*" >> "$DECK_TEST_CALLS"\nif [ '${name}' = claude ]; then echo '2.1.282 (Claude Code)'; fi\nif [ '${name}' = systemctl ] && [ "$2" = is-active ]; then if [ "$3" = fleetmates-deck.service ] && [ "$DECK_TEST_WEB_ACTIVE" = 1 ]; then exit 0; fi; exit 3; fi\nif [ '${name}' = systemctl ] && [ "$DECK_TEST_MODEL_WEB" = 1 ] && [ "$2" = enable ]; then\n  if [ -e "$DECK_TEST_WEB_ENTRY" ]; then\n    printf active > "$DECK_TEST_WEB_STATE"\n  elif grep -Fqx "ConditionPathExists=$DECK_TEST_WEB_ENTRY" "$XDG_CONFIG_HOME/systemd/user/fleetmates-deck.service"; then\n    printf skipped > "$DECK_TEST_WEB_STATE"\n  else\n    printf failed > "$DECK_TEST_WEB_STATE"\n    exit 1\n  fi\nfi\n`)
    execFileSync('chmod', ['700', file])
  }
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(root, 'data'), XDG_RUNTIME_DIR: runtime, PATH: `${bin}:${process.env.PATH}`, DECK_TEST_CALLS: calls, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }
  delete env.DECK_PORT
  const hubPath = isolatedHub || webEntry ? path.join(root, 'hub') : hub
  if (hubPath !== hub) {
    mkdirSync(hubPath)
    for (const name of ['bin', 'server', 'deckd', 'hook', 'systemd']) cpSync(path.join(hub, name), path.join(hubPath, name), { recursive: true, filter: source => !isolatedHub || source !== path.join(hub, 'server/main.mjs') })
    if (webEntry) writeFileSync(path.join(hubPath, 'server/main.mjs'), '')
  }
  const cliPath = path.join(hubPath, 'bin/fleetmates-deck.mjs')
  const run = (...args) => spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', timeout: 8000 })
  const runWith = (override, ...args) => spawnSync(process.execPath, [cliPath, ...args], { env: { ...env, ...override }, encoding: 'utf8', timeout: 8000 })
  return { root, home, config, state, runtime, calls, settings, env, hubPath, run, runWith }
}

async function listener(s, token, valid, delayMs = 0) {
  const script = path.join(s.root, 'listener.mjs')
  writeFileSync(script, `import http from 'node:http'\nimport fs from 'node:fs'\nimport { createHmac } from 'node:crypto'\nconst server = http.createServer((req, res) => {\n  fs.writeFileSync(process.env.REQUEST_FILE, req.url)\n  if (req.url === '/') {\n    res.setHeader('content-type', 'text/html')\n    res.end('<main id="deck-ready">Fleetmates Deck</main>')\n    return\n  }\n  const nonce = new URL(req.url, 'http://127.0.0.1').searchParams.get('nonce')\n  if (!/^[A-Za-z0-9_-]{32}$/.test(nonce || '') || req.url !== '/.well-known/fleetmates-deck/identity?nonce=' + nonce) {\n    res.writeHead(404).end()\n    return\n  }\n  const mac = createHmac('sha256', process.env.TEST_TOKEN).update('fleetmates-deck-open:' + nonce).digest('hex')\n  res.setHeader('content-type', 'application/json')\n  res.end(JSON.stringify({ nonce, mac: process.env.VALID === 'yes' ? mac : '0'.repeat(64) }))\n})\nserver.listen(0, '127.0.0.1', () => {\n  const port = server.address().port\n  if (Number(process.env.DELAY_MS)) server.close(() => {\n    process.stdout.write(String(port) + '\\n')\n    setTimeout(() => server.listen(port, '127.0.0.1'), Number(process.env.DELAY_MS))\n  })\n  else process.stdout.write(String(port) + '\\n')\n})\n`)
  const requestFile = path.join(s.root, 'request-url')
  const child = spawn(process.execPath, [script], { env: { ...process.env, TEST_TOKEN: token, VALID: valid ? 'yes' : 'no', DELAY_MS: String(delayMs), REQUEST_FILE: requestFile }, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())))
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`listener exited ${code}`)))
  })
  writeFileSync(path.join(s.config, 'fleetmates/deck/config.json'), JSON.stringify({ port }))
  return { child, port, requestFile }
}

test('dry run leaves settings, directories and services untouched', () => {
  const s = sandbox()
  const before = readFileSync(s.settings)
  const result = s.run('init', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(s.settings), before)
  assert.equal(readdirSync(s.config).length, 0)
  assert.equal(readdirSync(s.state).length, 0)
  assert.equal(existsSync(s.env.XDG_DATA_HOME), false)
  assert.equal(readdirSync(s.home).includes('.local'), false)
  assert.equal(readdirSync(s.root).includes('calls'), false)
})

test('hooksInstalled requires the installed command for every subscribed event', () => {
  const command = 'node /tmp/fleetmates-deck/hook/deck-hook.mjs'
  const settings = {
    hooks: Object.fromEntries(requiredHookEvents.map(event => [event, [
      { matcher: '*', hooks: [{ type: 'command', command, async: true }] }
    ]]))
  }
  assert.equal(hooksInstalled(settings, command), true)
  for (const event of requiredHookEvents) {
    const missing = structuredClone(settings)
    delete missing.hooks[event]
    assert.equal(hooksInstalled(missing, command), false, `missing ${event}`)
    const wrongCommand = structuredClone(settings)
    wrongCommand.hooks[event][0].hooks[0].command = 'node /tmp/unrelated-hook.mjs'
    assert.equal(hooksInstalled(wrongCommand, command), false, `wrong command for ${event}`)
  }
})

test('init installs every event required by the hook integration contract', () => {
  const s = sandbox()
  const result = s.run('init')
  assert.equal(result.status, 0, result.stderr)
  const settings = JSON.parse(readFileSync(s.settings, 'utf8'))
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...requiredHookEvents].sort())
  const command = [process.execPath, setupPaths(s.env).hook]
    .map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
  for (const event of requiredHookEvents) {
    assert.deepEqual(settings.hooks[event], [
      { matcher: '*', hooks: [{ type: 'command', command, async: true, timeout: 5 }] }
    ], event)
  }
})

test('dry run reports pending changes without exposing settings secrets', () => {
  const s = sandbox()
  const secret = 'sentinel-service-api-key-7f3e'
  writeFileSync(s.settings, JSON.stringify({ env: { SERVICE_API_KEY: secret } }))
  const result = s.run('init', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /settings: would update/)
  assert.match(result.stdout, /fleetmates-deck\.service: would write/)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret))
})

test('init merges hooks, preserves existing order and is byte identical twice', () => {
  const s = sandbox('existing-hooks.json')
  assert.equal(s.run('init').status, 0)
  const first = readFileSync(s.settings)
  const parsed = JSON.parse(first)
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, 'node /home/you/fleetmates-hook.mjs')
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'node /home/you/existing-hook.mjs')
  assert.equal(parsed.hooks.PreToolUse.filter(group => group.hooks.some(h => h.command?.includes('deck-hook.mjs'))).length, 1)
  assert.equal(s.run('init').status, 0)
  assert.deepEqual(readFileSync(s.settings), first)
  const backups = readdirSync(path.dirname(s.settings)).filter(name => name.includes('deck-backup-'))
  assert.equal(backups.length, 1)
  assert.deepEqual(readFileSync(path.join(path.dirname(s.settings), backups[0])), readFileSync(path.join(fixtures, 'existing-hooks.json')))
  assert.equal(statSync(path.join(s.state, 'fleetmates/deck/token')).mode & 0o777, 0o600)
  const calls = readFileSync(s.calls, 'utf8')
  assert.match(calls, /^systemctl:--user enable --now fleetmates-deckd.service fleetmates-deck.service$/m)
  assert.equal(calls.includes('restart fleetmates-deckd'), false)
})

test('settings replacement is atomic and preserves originals through interrupted writes', { concurrency: false }, () => {
  const s = sandbox('existing-hooks.json')
  const original = readFileSync(s.settings)
  const current = readSettings(s.settings)
  const next = { ...current.value, enabledPlugins: { 'example-plugin': true } }
  const methods = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, copyFileSync: fs.copyFileSync }
  const interruption = new Error('simulated settings interruption')
  for (const stage of ['write', 'rename']) {
    try {
      fs.writeFileSync = (file, ...args) => {
        if (stage === 'write' && String(file).startsWith(`${s.settings}.deck-`) && String(file).endsWith('.tmp')) {
          methods.writeFileSync(file, '{', args[1])
          throw interruption
        }
        return methods.writeFileSync(file, ...args)
      }
      fs.renameSync = (source, destination) => {
        if (stage === 'rename' && destination === s.settings) throw interruption
        return methods.renameSync(source, destination)
      }
      fs.copyFileSync = (source, destination, ...args) => {
        if (destination === s.settings) {
          methods.writeFileSync(destination, '{')
          throw interruption
        }
        return methods.copyFileSync(source, destination, ...args)
      }
      assert.throws(() => writeSettings(s.settings, current, next), error => error === interruption)
      assert.deepEqual(readFileSync(s.settings), original, `${stage} interruption preserves settings bytes`)
      assert.deepEqual(readSettings(s.settings).value, current.value)
      assert.equal(readdirSync(path.dirname(s.settings)).some(name => name.endsWith('.tmp')), false)
    } finally {
      Object.assign(fs, methods)
    }
  }
  const descriptor = fs.openSync(s.settings, 'r')
  try {
    const backup = writeSettings(s.settings, current, next)
    assert.deepEqual(readFileSync(backup), original)
    assert.deepEqual(readSettings(s.settings).value, next)
    assert.deepEqual(readFileSync(descriptor), original, 'existing readers retain the original file after replacement')
    assert.equal(readdirSync(path.dirname(s.settings)).some(name => name.endsWith('.tmp')), false)
  } finally {
    fs.closeSync(descriptor)
  }
})

test('init rotate token replaces the token and keeps private file mode', () => {
  const s = sandbox()
  assert.equal(s.run('init').status, 0)
  const tokenFile = path.join(s.state, 'fleetmates/deck/token')
  const original = readFileSync(tokenFile, 'utf8').trim()
  assert.match(original, /^[A-Za-z0-9_-]{43}$/)
  const result = s.run('init', '--rotate-token')
  assert.equal(result.status, 0, result.stderr)
  const replacement = readFileSync(tokenFile, 'utf8').trim()
  assert.match(replacement, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(replacement, original)
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600)
})

test('init skips the absent web entry and starts it after installation', () => {
  const s = sandbox('empty.json', { isolatedHub: true })
  const entry = path.join(s.hubPath, 'server/main.mjs')
  const serviceState = path.join(s.root, 'web-service-state')
  const model = { DECK_TEST_MODEL_WEB: '1', DECK_TEST_WEB_ENTRY: entry, DECK_TEST_WEB_STATE: serviceState }
  assert.equal(existsSync(entry), false)
  const first = s.runWith(model, 'init')
  assert.equal(first.status, 0, first.stderr)
  assert.equal(readFileSync(serviceState, 'utf8'), 'skipped')
  const unit = readFileSync(path.join(s.config, 'systemd/user/fleetmates-deck.service'), 'utf8')
  assert.ok(unit.split('\n').includes(`ConditionPathExists=${entry}`))
  writeFileSync(s.calls, '')
  const open = s.runWith(model, 'open')
  assert.equal(open.status, 1)
  assert.match(open.stderr, /web server entrypoint is not installed/)
  assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /systemctl:--user start fleetmates-deck\.service/)
  writeFileSync(entry, '')
  const second = s.runWith(model, 'init')
  assert.equal(second.status, 0, second.stderr)
  assert.equal(readFileSync(serviceState, 'utf8'), 'active')
})

test('fresh home without settings.json installs hooks without a backup', () => {
  const s = sandbox()
  unlinkSync(s.settings)
  assert.equal(existsSync(s.settings), false)
  const result = s.run('init')
  assert.equal(result.status, 0, result.stderr)
  const settings = JSON.parse(readFileSync(s.settings, 'utf8'))
  assert.equal(settings.hooks.SessionStart[0].matcher, '*')
  assert.equal(settings.hooks.SessionStart[0].hooks[0].async, true)
  assert.equal(readdirSync(path.dirname(s.settings)).filter(name => name.includes('deck-backup-')).length, 0)
})

test('changed web unit triggers try-restart only for web while active', () => {
  const s = sandbox()
  assert.equal(s.run('init').status, 0)
  const webUnit = path.join(s.config, 'systemd/user/fleetmates-deck.service')
  writeFileSync(webUnit, readFileSync(webUnit, 'utf8') + '# old entry\n')
  writeFileSync(s.calls, '')
  const result = s.runWith({ DECK_TEST_WEB_ACTIVE: '1' }, 'init')
  assert.equal(result.status, 0, result.stderr)
  const calls = readFileSync(s.calls, 'utf8').trim().split('\n')
  const reload = calls.indexOf('systemctl:--user daemon-reload')
  const webRestart = calls.indexOf('systemctl:--user try-restart fleetmates-deck.service')
  const enable = calls.indexOf('systemctl:--user enable --now fleetmates-deckd.service fleetmates-deck.service')
  assert.ok(reload >= 0 && webRestart > reload && enable > webRestart)
  assert.equal(calls.some(call => /restart fleetmates-deckd\.service/.test(call)), false)
  writeFileSync(s.calls, '')
  assert.equal(s.runWith({ DECK_TEST_WEB_ACTIVE: '1' }, 'init').status, 0)
  assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /try-restart/)
})

test('uninstall removes deck hooks and keeps other hook entries', () => {
  const s = sandbox('existing-hooks.json')
  assert.equal(s.run('init').status, 0)
  assert.equal(s.run('uninstall-hooks').status, 0)
  const parsed = JSON.parse(readFileSync(s.settings))
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, 'node /home/you/fleetmates-hook.mjs')
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'node /home/you/existing-hook.mjs')
  assert.equal(Object.values(parsed.hooks).flatMap(groups => groups.flatMap(group => group.hooks)).some(h => h.command?.includes('deck-hook.mjs')), false)
})

test('open uses a private bootstrap file after identity proof and reaches the deck', async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, true)
  try {
    const result = s.run('open')
    assert.equal(result.status, 0)
    assert.match(readFileSync(server.requestFile, 'utf8'), /^\/\.well-known\/fleetmates-deck\/identity\?nonce=[A-Za-z0-9_-]{32}$/)
    const calls = readFileSync(s.calls, 'utf8')
    assert.match(calls, /systemctl:--user start fleetmates-deck.service/)
    const argument = calls.split('\n').find(line => line.startsWith('xdg-open:'))?.slice('xdg-open:'.length)
    assert.ok(argument?.startsWith(path.join(s.state, 'fleetmates/deck/')))
    assert.equal(argument.includes(token), false)
    assert.equal(statSync(argument).mode & 0o777, 0o600)
    assert.equal(statSync(path.join(s.state, 'fleetmates/deck')).mode & 0o777, 0o700)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token))
    const bootstrap = readFileSync(argument, 'utf8')
    assert.doesNotMatch(bootstrap, /content-security-policy/i)
    const script = bootstrap.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    assert.ok(script)
    const redirects = []
    const context = createContext({ location: { replace(value) { redirects.push(value) } } }, { codeGeneration: { strings: false, wasm: false } })
    runInContext(script, context, { timeout: 1000 })
    assert.equal(redirects.length, 1)
    const url = redirects[0]
    assert.equal(url, `http://127.0.0.1:${server.port}/#token=${token}`)
    const response = await fetch(url)
    assert.equal(response.headers.get('content-type'), 'text/html')
    assert.match(await response.text(), /<main id="deck-ready">Fleetmates Deck<\/main>/)
    const executablePath = process.env.DECK_TEST_NO_BROWSER === '1' ? undefined : [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'].find(candidate => candidate && existsSync(candidate))
    if (executablePath) {
      const browser = await chromium.launch({ executablePath, headless: true })
      try {
        const page = await browser.newPage()
        await page.goto(pathToFileURL(argument).href)
        await page.waitForURL(url)
        assert.equal(await page.locator('#deck-ready').textContent({ timeout: 1500 }), 'Fleetmates Deck')
      } finally { await browser.close() }
    }
    assert.equal(readFileSync(server.requestFile, 'utf8').includes(token), false)
  } finally { server.child.kill() }
})

test('open uses validated DECK_PORT ahead of config port', async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, true)
  try {
    writeFileSync(path.join(s.config, 'fleetmates/deck/config.json'), JSON.stringify({ port: 9 }))
    const result = s.runWith({ DECK_PORT: String(server.port) }, 'open')
    assert.equal(result.status, 0, result.stderr)
    const argument = readFileSync(s.calls, 'utf8').split('\n').find(line => line.startsWith('xdg-open:'))?.slice('xdg-open:'.length)
    assert.ok(argument)
    assert.ok(readFileSync(argument, 'utf8').includes(`http://127.0.0.1:${server.port}/#token=${token}`))
    assert.equal(argument.includes(token), false)
    assert.equal(s.runWith({ DECK_PORT: 'invalid' }, 'open').status, 1)
    assert.equal(s.runWith({ DECK_PORT: '65536' }, 'open').status, 1)
  } finally { server.child.kill() }
})

test('open refuses a loopback listener without the token proof', async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, false)
  try {
    const result = s.run('open')
    assert.equal(result.status, 1)
    assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /xdg-open:/)
    assert.equal(readFileSync(server.requestFile, 'utf8').includes(token), false)
  } finally { server.child.kill() }
})

test('open waits for a valid listener after systemctl start returns', async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, true, 350)
  try {
    assert.equal(s.run('open').status, 0)
    const argument = readFileSync(s.calls, 'utf8').split('\n').find(line => line.startsWith('xdg-open:'))?.slice('xdg-open:'.length)
    assert.ok(argument?.startsWith(path.join(s.state, 'fleetmates/deck/')))
    assert.equal(argument.includes(token), false)
    assert.equal(readFileSync(server.requestFile, 'utf8').includes(token), false)
  } finally { server.child.kill() }
})

test('open stops retrying when no listener appears', async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, true, 10000)
  try {
    const started = Date.now()
    const result = s.run('open')
    assert.equal(result.status, 1)
    assert.ok(Date.now() - started < 5000)
    assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /xdg-open:/)
  } finally { server.child.kill() }
})

test('invalid settings stops init before it writes directories or services', () => {
  const s = sandbox()
  writeFileSync(s.settings, '{ broken')
  assert.equal(s.run('init').status, 1)
  assert.equal(readFileSync(s.settings, 'utf8'), '{ broken')
  assert.equal(readdirSync(s.config).length, 0)
  assert.equal(readdirSync(s.state).length, 0)
  assert.equal(readdirSync(s.root).includes('calls'), false)
})

test('init updates an old deck hook in place', () => {
  const s = sandbox()
  const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [
    { type: 'command', command: 'node /home/you/fleetmates-deck/hook/deck-hook.mjs', async: true, timeout: 5 },
    { type: 'command', command: 'node /home/you/other.mjs' }
  ] }] } }
  writeFileSync(s.settings, JSON.stringify(settings))
  assert.equal(s.run('init').status, 0)
  const groups = JSON.parse(readFileSync(s.settings)).hooks.PreToolUse
  assert.equal(groups.length, 1)
  assert.equal(groups[0].hooks.length, 2)
  assert.match(groups[0].hooks[0].command, /fleetmates-deck\/hook\/deck-hook\.mjs'$/)
  assert.equal(groups[0].hooks[1].command, 'node /home/you/other.mjs')
})

test('renamed Node init is idempotent and uninstall preserves unrelated groups', () => {
  const s = sandbox('existing-hooks.json')
  const executable = path.join(s.root, 'deck-node-runtime')
  fs.copyFileSync(process.execPath, executable)
  chmodSync(executable, 0o700)
  const original = JSON.parse(readFileSync(s.settings, 'utf8'))
  const target = setupPaths(s.env).hook
  const unrelated = [
    `echo '${target}'`, `/bin/sh '${target}'`,
    `'${executable}' /tmp/unrelated-hook.mjs`,
    `node '${target}'; echo unrelated`, `nodejs '${target}' extra`
  ]
  original.hooks.PreToolUse.push({ matcher: 'Bash', hooks: unrelated.map(command => ({ type: 'command', command })) })
  writeFileSync(s.settings, JSON.stringify(original))
  const run = (...args) => spawnSync(executable, [path.join(hub, 'bin/fleetmates-deck.mjs'), ...args], { env: s.env, encoding: 'utf8', timeout: 8000 })
  const first = run('init')
  assert.equal(first.status, 0, first.stderr)
  const installed = readFileSync(s.settings)
  const command = `'${executable}' '${target}'`
  const second = run('init')
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(readFileSync(s.settings), installed)
  for (const event of requiredHookEvents) {
    const entries = JSON.parse(installed).hooks[event].flatMap(group => group.hooks)
    assert.equal(entries.filter(hook => hook.command === command).length, 1, event)
  }
  assert.equal(isDeckHook(command, command), true)
  for (const other of unrelated) assert.equal(isDeckHook(other, command), false, other)
  const removed = run('uninstall-hooks')
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual(JSON.parse(readFileSync(s.settings)), original)
})

test('legacy node and nodejs hooks merge once and uninstall without removing other commands', () => {
  const command = "'/opt/deck/node-runtime' '/tmp/fleetmates-deck/hook/deck-hook.mjs'"
  const unrelated = [
    'echo /tmp/old/hub/hook/deck-hook.mjs',
    '/bin/sh /tmp/old/hub/hook/deck-hook.mjs',
    'nodejs /tmp/other/hook/deck-hook.mjs',
    'node /tmp/old/hub/hook/deck-hook.mjs && echo unrelated',
    'nodejs /tmp/old/hub/hook/deck-hook.mjs extra'
  ]
  for (const executable of ['node', 'nodejs', '/usr/bin/node', '/usr/bin/nodejs']) {
    const legacy = `${executable} /tmp/old/hub/hook/deck-hook.mjs`
    assert.equal(isDeckHook(legacy), true, executable)
    const preserved = { hooks: { SessionStart: [{ matcher: 'Bash', hooks: unrelated.map(command => ({ type: 'command', command })) }] } }
    const original = structuredClone(preserved)
    original.hooks.SessionStart.unshift({ matcher: '*', hooks: [{ type: 'command', command: legacy }] })
    const once = transformHooks(original, command)
    assert.deepEqual(transformHooks(once, command), once, executable)
    assert.deepEqual(transformHooks(original, command, true), preserved, executable)
    assert.deepEqual(transformHooks(once, command, true), preserved, executable)
    for (const other of unrelated) assert.equal(isDeckHook(other, command), false, other)
  }
})

test('init replaces an old hub path hook and preserves unrelated commands', () => {
  const s = sandbox()
  const old = 'node /tmp/old-install/hub/hook/deck-hook.mjs'
  const unrelated = ['node /home/you/other/hook/deck-hook.mjs', 'echo /tmp/old-install/hub/hook/deck-hook.mjs', 'node\n/tmp/old-install/hub/hook/deck-hook.mjs', 'node /home/you/other.mjs']
  writeFileSync(s.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [old, ...unrelated].map(command => ({ type: 'command', command })) }] } }))
  assert.equal(s.run('init').status, 0)
  const groups = JSON.parse(readFileSync(s.settings)).hooks.PreToolUse
  assert.equal(groups.length, 1)
  assert.equal(groups[0].hooks.length, 5)
  assert.match(groups[0].hooks[0].command, /fleetmates-deck\/hook\/deck-hook\.mjs'$/)
  assert.deepEqual(groups[0].hooks.slice(1).map(hook => hook.command), unrelated)
})

test('uninstall removes an old hub path hook and preserves unrelated commands', () => {
  const s = sandbox()
  const old = 'node /tmp/old-install/hub/hook/deck-hook.mjs'
  const unrelated = ['node /home/you/other/hook/deck-hook.mjs', 'echo /tmp/old-install/hub/hook/deck-hook.mjs', 'node\n/tmp/old-install/hub/hook/deck-hook.mjs', 'node /home/you/other.mjs']
  writeFileSync(s.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [old, ...unrelated].map(command => ({ type: 'command', command })) }] } }))
  assert.equal(s.run('uninstall-hooks').status, 0)
  const groups = JSON.parse(readFileSync(s.settings)).hooks.PreToolUse
  assert.deepEqual(groups[0].hooks.map(hook => hook.command), unrelated)
})

test('restricted old hook gains wildcard coverage without widening unrelated hooks', () => {
  const s = sandbox()
  writeFileSync(s.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: 'node /home/you/fleetmates-deck/hook/deck-hook.mjs', async: true, timeout: 5 },
    { type: 'command', command: 'node /home/you/other.mjs' }
  ] }] } }))
  assert.equal(s.run('init').status, 0)
  const groups = JSON.parse(readFileSync(s.settings)).hooks.PreToolUse
  assert.equal(groups[0].matcher, 'Bash')
  assert.deepEqual(groups[0].hooks.map(hook => hook.command), ['node /home/you/other.mjs'])
  assert.equal(groups.filter(group => group.matcher === '*' && group.hooks.some(hook => hook.command?.endsWith("deck-hook.mjs'"))).length, 1)
  assert.match(s.run('doctor').stdout, /hooks: ok/)
})

test('doctor and status read setup state without service mutations', () => {
  const s = sandbox()
  assert.equal(s.run('init').status, 0)
  writeFileSync(s.calls, '')
  const doctor = s.run('doctor')
  assert.equal(doctor.status, 0)
  assert.match(doctor.stdout, /claude: ok/)
  assert.match(doctor.stdout, /hooks: ok/)
  const status = s.run('status')
  assert.equal(status.status, 0)
  const summary = JSON.parse(status.stdout)
  assert.equal(summary.hooks, true)
  assert.equal(summary.claudeVersion, '2.1.282')
  assert.equal(summary.testedClaudeVersion, '2.1.282')
  assert.equal(summary.livePtys, 0)
  const serviceCalls = readFileSync(s.calls, 'utf8').trim().split('\n').filter(call => call.startsWith('systemctl:'))
  assert.deepEqual(serviceCalls, [
    'systemctl:--user is-active fleetmates-deckd.service',
    'systemctl:--user is-active fleetmates-deckd.service',
    'systemctl:--user is-active fleetmates-deck.service'
  ])
})

for (const stall of ['hello', 'list', null]) {
  test(`setup socket probe ${stall ? `bounds stalled ${stall}` : 'reads a responsive daemon'}`, async () => {
    const s = sandbox()
    const paths = setupPaths(s.env)
    mkdirSync(paths.runtime, { recursive: true })
    const sockets = new Set()
    const requests = []
    const server = createServer(socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          requests.push(message.op)
          if (message.op === stall) continue
          assert.equal(message.op === 'hello' || message.op === 'list', true)
          if (message.op === 'hello') {
            assert.equal(message.proto, 1)
            assert.equal(message.client.kind, 'terminal')
          }
          socket.write(`${JSON.stringify({ id: message.id, ok: true, ptys: [{ id: 'one' }, { id: 'two' }] })}\n`)
        }
      })
    })
    await new Promise((resolve, reject) => server.listen(path.join(paths.runtime, 'deckd.sock'), resolve).once('error', reject))
    const run = file => ({ status: 0, stdout: file === 'claude' ? '2.1.282' : 'active' })
    async function bounded(pending) {
      let timer
      try {
        return await Promise.race([pending, new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('setup socket probe exceeded 3 seconds')), 3000)
        })])
      } finally { clearTimeout(timer) }
    }
    try {
      const checks = await bounded(doctor(paths, 'unused', { run }))
      assert.equal(checks.find(check => check.id === 'deckd').state, stall === 'hello' ? 'failed' : 'ok')
      const summary = await bounded(status(paths, 'unused', { run }))
      assert.equal(summary.livePtys, stall ? 0 : 2)
      assert.equal(summary.socket, true)
      assert.deepEqual(requests, stall === 'hello' ? ['hello', 'hello'] : ['hello', 'hello', 'list'])
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(sockets.size, 0, 'probe closes connections after success or timeout')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

test('doctor fails when the configured hook script is missing or not a file', () => {
  const s = sandbox()
  assert.equal(s.run('init').status, 0)
  const hook = setupPaths(s.env).hook
  unlinkSync(hook)
  const missing = s.run('doctor')
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /hooks: failed \(Observation hook script missing or unreadable\)/)
  mkdirSync(hook)
  const directory = s.run('doctor')
  assert.equal(directory.status, 1)
  assert.match(directory.stdout, /hooks: failed \(Observation hook script missing or unreadable\)/)
})

test('doctor fails when the configured hook script is unreadable', () => {
  const s = sandbox()
  assert.equal(s.run('init').status, 0)
  const hook = setupPaths(s.env).hook
  chmodSync(hook, 0o000)
  try {
    const result = s.run('doctor')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /hooks: failed \(Observation hook script missing or unreadable\)/)
  } finally { chmodSync(hook, 0o600) }
})

test('doctor finds the scribed Unix listener in the runtime directory', async () => {
  const s = sandbox()
  const server = createServer(socket => socket.end())
  await new Promise((resolve, reject) => server.listen(path.join(s.runtime, 'turbidassist.sock'), resolve).once('error', reject))
  try {
    const checks = await doctor(setupPaths(s.env), 'unused', { run: file => file === 'claude' ? { status: 0, stdout: '2.1.282' } : { status: 3 } })
    assert.equal(checks.find(check => check.id === 'scribed').state, 'ok')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('installed units use absolute Node and hub paths with private umask', () => {
  const s = sandbox()
  assert.equal(s.run('init').status, 0)
  const unitDir = path.join(s.config, 'systemd/user')
  const deckd = readFileSync(path.join(unitDir, 'fleetmates-deckd.service'), 'utf8')
  const web = readFileSync(path.join(unitDir, 'fleetmates-deck.service'), 'utf8')
  assert.ok(deckd.includes(`ExecStart="${process.execPath}" "${path.join(hub, 'deckd/main.mjs')}"`))
  assert.ok(web.includes(`ExecStart="${process.execPath}" "${path.join(hub, 'server/main.mjs')}"`))
  assert.match(deckd, /UMask=0077/)
  assert.match(web, /UMask=0077/)
  assert.doesNotMatch(deckd, /^Documentation=/m)
  assert.doesNotMatch(web, /^Documentation=/m)
})

test('installed hook command runs from an XDG data directory with spaces', () => {
  const s = sandbox()
  const data = path.join(s.root, "deck review home's")
  const result = s.runWith({ XDG_DATA_HOME: data }, 'init')
  assert.equal(result.status, 0, result.stderr)
  const command = JSON.parse(readFileSync(s.settings, 'utf8')).hooks.SessionStart.at(-1).hooks[0].command
  const hook = spawnSync('/bin/sh', ['-c', command], { env: { ...s.env, XDG_DATA_HOME: data }, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'installed-hook-session', cwd: s.root }), encoding: 'utf8', timeout: 3000 })
  assert.equal(hook.status, 0, hook.stderr)
  assert.equal(hook.stdout, '')
  const spool = path.join(s.state, 'fleetmates/deck/spool')
  const files = readdirSync(spool)
  assert.equal(files.length, 1)
  const event = JSON.parse(readFileSync(path.join(spool, files[0]), 'utf8'))
  assert.equal(event.hook.hook_event_name, 'SessionStart')
  assert.equal(event.hook.session_id, 'installed-hook-session')
})

test('both unit templates quote executable and entry paths with spaces', () => {
  const nodePath = '/tmp/node install/bin/node'
  const hubPath = '/tmp/deck review home/hub'
  for (const [name, entry] of [['fleetmates-deck.service', 'server/main.mjs'], ['fleetmates-deckd.service', 'deckd/main.mjs']]) {
    const rendered = renderUnit(name, nodePath, hubPath)
    assert.ok(rendered.includes(`ExecStart="${nodePath}" "${hubPath}/${entry}"`))
    if (name === 'fleetmates-deck.service') assert.ok(rendered.split('\n').includes(`ConditionPathExists=${hubPath}/${entry}`))
    assert.equal(rendered.includes('@NODE@') || rendered.includes('@ENTRY@'), false)
  }
})
