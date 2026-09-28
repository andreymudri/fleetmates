import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { renderUnit } from '../../server/setup/units.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const cli = path.join(hub, 'bin/fleetmates-deck.mjs')
const fixtures = path.join(hub, 'test/fixtures/settings')

function sandbox(fixture = 'empty.json') {
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
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}:'"$*" >> "$DECK_TEST_CALLS"\nif [ '${name}' = claude ]; then echo '2.1.282 (Claude Code)'; fi\nif [ '${name}' = systemctl ] && [ "$2" = is-active ]; then if [ "$3" = fleetmates-deck.service ] && [ "$DECK_TEST_WEB_ACTIVE" = 1 ]; then exit 0; fi; exit 3; fi\n`)
    execFileSync('chmod', ['700', file])
  }
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(root, 'data'), XDG_RUNTIME_DIR: runtime, PATH: `${bin}:${process.env.PATH}`, DECK_TEST_CALLS: calls, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }
  delete env.DECK_PORT
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 8000 })
  const runWith = (override, ...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...override }, encoding: 'utf8', timeout: 8000 })
  return { root, home, config, state, runtime, calls, settings, env, run, runWith }
}

async function listener(s, token, valid, delayMs = 0) {
  const script = path.join(s.root, 'listener.mjs')
  writeFileSync(script, `import http from 'node:http'\nimport fs from 'node:fs'\nimport { createHmac } from 'node:crypto'\nconst server = http.createServer((req, res) => {\n  fs.writeFileSync(process.env.REQUEST_FILE, req.url)\n  if (req.url === '/') {\n    res.setHeader('content-type', 'text/html')\n    res.end('<main id="deck-ready">Fleetmates Deck</main>')\n    return\n  }\n  const nonce = new URL(req.url, 'http://127.0.0.1').searchParams.get('nonce')\n  const mac = createHmac('sha256', process.env.TEST_TOKEN).update('fleetmates-deck-open:' + nonce).digest('hex')\n  res.setHeader('content-type', 'application/json')\n  res.end(JSON.stringify({ nonce, mac: process.env.VALID === 'yes' ? mac : '0'.repeat(64) }))\n})\nserver.listen(0, '127.0.0.1', () => {\n  const port = server.address().port\n  if (Number(process.env.DELAY_MS)) server.close(() => {\n    process.stdout.write(String(port) + '\\n')\n    setTimeout(() => server.listen(port, '127.0.0.1'), Number(process.env.DELAY_MS))\n  })\n  else process.stdout.write(String(port) + '\\n')\n})\n`)
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
  assert.equal(readdirSync(s.home).includes('.local'), false)
  assert.equal(readdirSync(s.root).includes('calls'), false)
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
  const s = sandbox()
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, true)
  try {
    const result = s.run('open')
    assert.equal(result.status, 0)
    const calls = readFileSync(s.calls, 'utf8')
    assert.match(calls, /systemctl:--user start fleetmates-deck.service/)
    const argument = calls.split('\n').find(line => line.startsWith('xdg-open:'))?.slice('xdg-open:'.length)
    assert.ok(argument?.startsWith(path.join(s.state, 'fleetmates/deck/')))
    assert.equal(argument.includes(token), false)
    assert.equal(statSync(argument).mode & 0o777, 0o600)
    assert.equal(statSync(path.join(s.state, 'fleetmates/deck')).mode & 0o777, 0o700)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token))
    const bootstrap = readFileSync(argument, 'utf8')
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
  const s = sandbox()
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
  const s = sandbox()
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
  const s = sandbox()
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
  const s = sandbox()
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
  assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /enable|start|restart|daemon-reload/)
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
  const hook = spawnSync('/bin/sh', ['-c', command], { env: { ...s.env, XDG_DATA_HOME: data }, input: '{}', encoding: 'utf8', timeout: 3000 })
  assert.equal(hook.status, 0, hook.stderr)
  assert.equal(hook.stdout, '')
})

test('both unit templates quote executable and entry paths with spaces', () => {
  const nodePath = '/tmp/node install/bin/node'
  const hubPath = '/tmp/deck review home/hub'
  for (const [name, entry] of [['fleetmates-deck.service', 'server/main.mjs'], ['fleetmates-deckd.service', 'deckd/main.mjs']]) {
    const rendered = renderUnit(name, nodePath, hubPath)
    assert.ok(rendered.includes(`ExecStart="${nodePath}" "${hubPath}/${entry}"`))
    assert.equal(rendered.includes('@NODE@') || rendered.includes('@ENTRY@'), false)
  }
})
