import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { createServer } from 'node:net'
import { once } from 'node:events'
import test, { afterEach } from 'node:test'
import { posixTest as posixOnlyTest } from '../helpers/platform.mjs'

// The sandbox tests run /bin/sh fake binaries and use Unix sockets and POSIX file modes, so they skip on Windows.
// The injected-platform tests at the end of this file use plain `test` and run everywhere.
const SANDBOX_REASON = 'the setup sandbox runs /bin/sh fake binaries and uses Unix sockets and POSIX file modes'
const posixTest = (name, optsOrFn, fn) => typeof optsOrFn === 'function'
  ? posixOnlyTest(name, { reason: SANDBOX_REASON }, optsOrFn)
  : posixOnlyTest(name, { reason: SANDBOX_REASON, ...optsOrFn }, fn)
// The CLI runs in a child process on the host platform, so these tests cannot inject one. They pin the linux
// service manager and opener (systemd units, systemctl, xdg-open); on darwin the CLI uses launchd and `open`, whose
// behaviour the injected-platform tests near the end of this file and service.test cover.
const SYSTEMD_ONLY = process.platform !== 'linux' && 'Linux only: the CLI child process uses systemd units, systemctl and xdg-open'
import { chromium } from 'playwright-core'
import { doctor, status } from '../../server/setup/doctor.mjs'
import { PROTO } from '../../deckd/protocol.mjs'
import { hooksInstalled, isDeckHook, readSettings, transformHooks, writeSettings } from '../../server/setup/hooks.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { renderUnit } from '../../server/setup/units.mjs'
import { newerVersion, testedVersion } from '../helpers/tested-version.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const fixtures = path.join(hub, 'test/fixtures/settings')
const requiredHookEvents = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged',
  'PreCompact', 'PostCompact'
]

// Every sandbox root, and the ones the current test has not yet had removed.
const sandboxRoots = []
const pendingRoots = []
// Every listener child, and the ones the current test has not yet had stopped.
const startedListeners = []
const runningListeners = []
afterEach(async () => {
  for (const child of runningListeners.splice(0)) await stopListener(child)
  for (const root of pendingRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function sandbox(fixture = 'empty.json', { isolatedHub = false, webEntry = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'deck-setup-'))
  sandboxRoots.push(root)
  pendingRoots.push(root)
  const home = path.join(root, 'home')
  const config = path.join(root, 'config')
  const state = path.join(root, 'state')
  const runtime = path.join(root, 'runtime')
  const bin = path.join(root, 'bin')
  const calls = path.join(root, 'calls')
  for (const dir of [home, config, state, runtime, bin, path.join(home, '.claude')]) mkdirSync(dir, { recursive: true })
  const settings = path.join(home, '.claude/settings.json')
  writeFileSync(settings, readFileSync(path.join(fixtures, fixture)))
  // Every launcher `open` may try is faked, so no test reaches the real desktop. By default only
  // xdg-open succeeds; DECK_TEST_DEFAULT_BROWSER, DECK_TEST_GTK_LAUNCH, DECK_TEST_XDG_OPEN_STATUS steer them.
  for (const name of ['systemctl', 'xdg-open', 'claude', 'notify-send', 'xdg-settings', 'gtk-launch', 'gio', 'deck-test-browser']) {
    const file = path.join(bin, name)
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}:'"$*" >> "$DECK_TEST_CALLS"\nif [ '${name}' = claude ]; then echo "\${DECK_TEST_CLAUDE_VERSION:-${testedVersion()}} (Claude Code)"; fi\nif [ '${name}' = xdg-settings ]; then [ -n "$DECK_TEST_DEFAULT_BROWSER" ] || exit 1; echo "$DECK_TEST_DEFAULT_BROWSER"; exit 0; fi\nif [ '${name}' = gtk-launch ]; then exit \${DECK_TEST_GTK_LAUNCH:-1}; fi\nif [ '${name}' = gio ] || [ '${name}' = deck-test-browser ]; then exit 1; fi\nif [ '${name}' = xdg-open ]; then exit \${DECK_TEST_XDG_OPEN_STATUS:-0}; fi\nif [ '${name}' = systemctl ] && [ "$2" = is-active ]; then unit="$3"; if [ "$unit" = --quiet ]; then unit="$4"; fi; if [ "$unit" = fleetmates-deck.service ] && [ "$DECK_TEST_WEB_ACTIVE" = 1 ]; then exit 0; fi; if [ "$unit" = fleetmates-deckd.service ] && [ "$DECK_TEST_DECKD_ACTIVE" = 1 ]; then exit 0; fi; exit 3; fi\nif [ '${name}' = systemctl ] && [ "$DECK_TEST_MODEL_WEB" = 1 ] && [ "$2" = enable ]; then\n  if [ -e "$DECK_TEST_WEB_ENTRY" ]; then\n    printf active > "$DECK_TEST_WEB_STATE"\n  elif grep -Fqx "ConditionPathExists=$DECK_TEST_WEB_ENTRY" "$XDG_CONFIG_HOME/systemd/user/fleetmates-deck.service"; then\n    printf skipped > "$DECK_TEST_WEB_STATE"\n  else\n    printf failed > "$DECK_TEST_WEB_STATE"\n    exit 1\n  fi\nfi\n`)
    execFileSync('chmod', ['700', file])
  }
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(root, 'data'), XDG_RUNTIME_DIR: runtime, PATH: `${bin}:${process.env.PATH}`, DECK_TEST_CALLS: calls, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }
  delete env.DECK_PORT
  delete env.BROWSER
  const hubPath = isolatedHub || webEntry ? path.join(root, 'hub') : hub
  if (hubPath !== hub) {
    mkdirSync(hubPath)
    // package.json carries fleetmatesDeck.testedClaudeCode, which doctor reads.
    cpSync(path.join(hub, 'package.json'), path.join(hubPath, 'package.json'))
    for (const name of ['bin', 'server', 'deckd', 'hook', 'systemd', 'platform']) cpSync(path.join(hub, name), path.join(hubPath, name), { recursive: true, filter: source => !isolatedHub || source !== path.join(hub, 'server/main.mjs') })
    if (webEntry) writeFileSync(path.join(hubPath, 'server/main.mjs'), '')
  }
  const cliPath = path.join(hubPath, 'bin/fleetmates-deck.mjs')
  const run = (...args) => spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', timeout: 8000 })
  const runWith = (override, ...args) => spawnSync(process.execPath, [cliPath, ...args], { env: { ...env, ...override }, encoding: 'utf8', timeout: 8000 })
  return { root, home, config, state, runtime, calls, settings, env, hubPath, run, runWith }
}

/** Stop a listener child and wait until it has exited. */
async function stopListener(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

async function listener(s, token, valid, delayMs = 0, { relayPort = 0, legacyProof = false } = {}) {
  const listenerRoot = mkdtempSync(path.join(s.root, 'listener-'))
  const script = path.join(listenerRoot, 'listener.mjs')
  writeFileSync(script, `import http from 'node:http'\nimport fs from 'node:fs'\nimport { createHmac } from 'node:crypto'\nprocess.stdin.on('end', () => process.exit(0)).resume()\nconst server = http.createServer((req, res) => {\n  fs.writeFileSync(process.env.REQUEST_FILE, req.url)\n  if (Number(process.env.RELAY_PORT)) {\n    const forwarded = http.get({ hostname: '127.0.0.1', port: Number(process.env.RELAY_PORT), path: req.url, headers: { host: req.headers.host } }, upstream => {\n      res.writeHead(upstream.statusCode, upstream.headers)\n      upstream.pipe(res)\n    })\n    forwarded.on('error', () => res.writeHead(502).end())\n    return\n  }\n  if (req.url === '/') {\n    res.setHeader('content-type', 'text/html')\n    res.end('<main id="deck-ready">Fleetmates Deck</main>')\n    return\n  }\n  const nonce = new URL(req.url, 'http://127.0.0.1').searchParams.get('nonce')\n  if (!/^[A-Za-z0-9_-]{32}$/.test(nonce || '') || req.url !== '/.well-known/fleetmates-deck/identity?nonce=' + nonce) {\n    res.writeHead(404).end()\n    return\n  }\n  const mac = createHmac('sha256', process.env.TEST_TOKEN).update('fleetmates-deck-open:' + (process.env.LEGACY_PROOF === 'yes' ? '' : server.address().port + ':') + nonce).digest('hex')\n  res.setHeader('content-type', 'application/json')\n  res.end(JSON.stringify({ nonce, mac: process.env.VALID === 'yes' ? mac : '0'.repeat(64) }))\n})\nserver.listen(0, '127.0.0.1', () => {\n  const port = server.address().port\n  if (Number(process.env.DELAY_MS)) server.close(() => {\n    process.stdout.write(String(port) + '\\n')\n    setTimeout(() => server.listen(port, '127.0.0.1'), Number(process.env.DELAY_MS))\n  })\n  else process.stdout.write(String(port) + '\\n')\n})\n`)
  const requestFile = path.join(listenerRoot, 'request-url')
  const child = spawn(process.execPath, [script], { env: { ...process.env, TEST_TOKEN: token, VALID: valid ? 'yes' : 'no', RELAY_PORT: String(relayPort), LEGACY_PROOF: legacyProof ? 'yes' : 'no', DELAY_MS: String(delayMs), REQUEST_FILE: requestFile }, stdio: ['pipe', 'pipe', 'pipe'] })
  startedListeners.push(child)
  runningListeners.push(child)
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())))
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`listener exited ${code}`)))
  })
  writeFileSync(path.join(s.config, 'fleetmates/deck/config.json'), JSON.stringify({ port }))
  return { child, port, requestFile }
}

posixTest('dry run leaves settings, directories and services untouched', () => {
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

posixTest('hooksInstalled requires the installed command for every subscribed event', () => {
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
  for (const event of ['WorktreeCreate', 'WorktreeRemove']) {
    const intercepted = structuredClone(settings)
    intercepted.hooks[event] = [{ hooks: [{ type: 'command', command, async: true }] }]
    assert.equal(hooksInstalled(intercepted, command), false, `deck must not intercept ${event}`)
  }
})

posixTest('init installs every event required by the hook integration contract', () => {
  const s = sandbox()
  const result = s.run('init')
  assert.equal(result.status, 0, result.stderr)
  const settings = JSON.parse(readFileSync(s.settings, 'utf8'))
  assert.equal(Object.hasOwn(settings.hooks, 'WorktreeCreate'), false)
  assert.equal(Object.hasOwn(settings.hooks, 'WorktreeRemove'), false)
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...requiredHookEvents].sort())
  const command = [process.execPath, setupPaths(s.env).hook]
    .map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
  for (const event of requiredHookEvents) {
    assert.deepEqual(settings.hooks[event], [
      { matcher: '*', hooks: [{ type: 'command', command, async: true, timeout: 5 }] }
    ], event)
  }
})

posixTest('init writes the tiers.json stub with mode 0600 and the schema beside it, and leaves an existing tiers.json untouched', () => {
  const s = sandbox()
  const config = path.join(s.config, 'fleetmates/deck')
  const tiers = path.join(config, 'tiers.json')
  assert.match(s.run('init', '--dry-run').stdout, /tiers: .*tiers\.json \(would create\)/)
  assert.equal(existsSync(tiers), false, 'a dry run writes nothing')
  const first = s.run('init')
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(JSON.parse(readFileSync(tiers, 'utf8')), { $schema: './tiers.schema.json', version: 1, extends: 'default', disable: [], entries: [] })
  assert.equal(statSync(tiers).mode & 0o777, 0o600)
  const schema = path.join(config, 'tiers.schema.json')
  assert.equal(readFileSync(schema, 'utf8'), readFileSync(path.join(hub, 'server/approvals/tiers.schema.json'), 'utf8'))
  assert.equal(statSync(schema).mode & 0o777, 0o600)
  const edited = '{ "version": 1, "disable": ["safe.npm.run-script"] }\n'
  writeFileSync(tiers, edited)
  assert.match(s.run('init', '--dry-run').stdout, /tiers: .*tiers\.json \(unchanged\)/)
  assert.equal(s.run('init').status, 0)
  assert.equal(readFileSync(tiers, 'utf8'), edited, 'the owner\'s tiers.json is kept')
})

posixTest('audit prints approval and rule audit rows oldest first, one per line, with redacted summaries, filtered by --repo and --since', async () => {
  const s = sandbox()
  const { openDeckDb } = await import('../../server/db/index.mjs')
  const state = path.join(s.state, 'fleetmates/deck')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const store = openDeckDb(path.join(state, 'deck.db'))
  const day = text => new Date(`${text}T12:00:00`).getTime()
  store.run("INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES('/home/you/dev/web','web',0,1,'web',0), ('/home/you/dev/api','api',1,0,'api',0)")
  store.run('INSERT INTO approval_audit(at,kind,request_id,repo_id,tier,via,choice,summary) VALUES(?,?,?,?,?,?,?,?)', day('2026-10-03'), 'answered', 'r2', '/home/you/dev/web', 'safe', 'browser', 'allow', 'curl -H "Authorization: Bearer abcdefghijklmnop" https://example.invalid')
  store.run('INSERT INTO approval_audit(at,kind,request_id,repo_id,tier,via,choice,summary) VALUES(?,?,?,?,?,?,?,?)', day('2026-10-01'), 'refused', 'r1', '/home/you/dev/api', 'destructive', 'browser', 'confirm_required', 'rm -rf build')
  store.run('INSERT INTO approval_audit(at,kind,tiers_sha256) VALUES(?,?,?)', day('2026-10-02'), 'tiers_loaded', 'abc')
  store.run('INSERT INTO rule_audit(at,repo_id,pattern,action,actor) VALUES(?,?,?,?,?)', day('2026-10-02') + 1, '/home/you/dev/web', 'Bash(npm run test)', 'added', 'suggestion')
  store.close()
  const all = s.run('audit')
  assert.equal(all.status, 0, all.stderr)
  const lines = all.stdout.trim().split('\n')
  assert.equal(lines.length, 4)
  assert.match(lines[0], /^2026-10-01T\S+ refused repo=api tier=destructive via=browser choice=confirm_required summary="rm -rf build"$/)
  assert.match(lines[1], /^2026-10-02T\S+ tiers_loaded repo=- tier=- via=- choice=- summary=""$/)
  assert.match(lines[2], /^2026-10-02T\S+ rule_added repo=web pattern="Bash\(npm run test\)" actor=suggestion$/)
  assert.match(lines[3], /^2026-10-03T\S+ answered repo=web tier=safe via=browser choice=allow summary="curl -H \\"Authorization: Bearer \*\*\*\\" https:\/\/example.invalid"$/)
  assert.doesNotMatch(all.stdout, /abcdefghijklmnop/)
  const web = s.run('audit', '--repo', 'web').stdout.trim().split('\n')
  assert.deepEqual(web.map(line => line.split(' ')[1]), ['rule_added', 'answered'])
  const since = s.run('audit', '--since', '2026-10-02').stdout.trim().split('\n')
  assert.deepEqual(since.map(line => line.split(' ')[1]), ['tiers_loaded', 'rule_added', 'answered'])
  const bad = s.run('audit', '--since', '2026-13-40')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /usage: .*audit \[--repo <name>\] \[--since <YYYY-MM-DD>\]/)
})

function dispatchSyntheticWorktree(settings, event, s, directory) {
  const handlers = (settings.hooks?.[event] ?? []).flatMap(group => group.hooks ?? [])
  if (!handlers.length) {
    if (event === 'WorktreeCreate') mkdirSync(directory)
    else fs.rmSync(directory, { recursive: true })
    return { defaultUsed: true, directoryExists: existsSync(directory) }
  }
  for (const hook of handlers) {
    const result = spawnSync('/bin/sh', ['-c', hook.command], {
      env: s.env, encoding: 'utf8', timeout: 3000,
      input: JSON.stringify({ hook_event_name: event, session_id: 'synthetic-worktree', cwd: s.root, name: 'fixture', worktree_path: directory })
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
  }
  return { defaultUsed: false, directoryExists: existsSync(directory) }
}

for (const event of ['WorktreeCreate', 'WorktreeRemove']) {
  posixTest(`init preserves default ${event} dispatch instead of registering a silent observer`, () => {
    const s = sandbox()
    assert.equal(s.run('init').status, 0)
    const settings = JSON.parse(readFileSync(s.settings, 'utf8'))
    const directory = path.join(s.root, 'synthetic-worktree')
    if (event === 'WorktreeRemove') mkdirSync(directory)
    const legacy = { hooks: { [event]: [{ hooks: settings.hooks.SessionStart[0].hooks }] } }
    assert.deepEqual(dispatchSyntheticWorktree(legacy, event, s, directory), {
      defaultUsed: false, directoryExists: event === 'WorktreeRemove'
    })
    assert.deepEqual(dispatchSyntheticWorktree(settings, event, s, directory), {
      defaultUsed: true, directoryExists: event === 'WorktreeCreate'
    })
  })
}

posixTest('init and uninstall remove only legacy deck worktree handlers and preserve opaque groups', () => {
  for (const action of ['init', 'uninstall-hooks']) {
    const s = sandbox()
    const installed = `'${process.execPath}' '${setupPaths(s.env).hook}'`
    const preserved = { env: { KEEP: 'unchanged' }, hooks: {} }
    const legacy = []
    for (const event of ['WorktreeCreate', 'WorktreeRemove']) {
      const other = { type: 'command', command: 'nodejs /tmp/third-party/worktree-handler.mjs', custom: { keep: true } }
      const opaque = { matcher: 'vendor', hooks: [{ type: 'http', url: 'http://127.0.0.1:9/hooks', command: installed }, { command: installed, vendorField: true }, null], custom: 'opaque' }
      const empty = { matcher: 'empty', hooks: [], extra: true }
      preserved.hooks[event] = [{ matcher: 'custom', hooks: [other], metadata: 'keep' }, opaque, empty, { matcher: 'unknown', vendorField: true }, null]
      legacy.push(['node /tmp/old-install/hub/hook/deck-hook.mjs', 'nodejs /tmp/old/fleetmates-deck/hook/deck-hook.mjs', installed])
    }
    const input = structuredClone(preserved)
    for (const [index, event] of ['WorktreeCreate', 'WorktreeRemove'].entries()) {
      input.hooks[event][0].hooks.unshift({ type: 'command', command: legacy[index][0] })
      input.hooks[event].splice(1, 0, { matcher: '*', hooks: legacy[index].slice(1).map(command => ({ type: 'command', command })) })
    }
    const originalBytes = Buffer.from(JSON.stringify(input))
    writeFileSync(s.settings, originalBytes)
    const result = s.run(action)
    assert.equal(result.status, 0, result.stderr)
    const updated = readFileSync(s.settings)
    const parsed = JSON.parse(updated)
    for (const event of ['WorktreeCreate', 'WorktreeRemove']) assert.deepEqual(parsed.hooks[event], preserved.hooks[event], `${action} ${event}`)
    assert.deepEqual(readFileSync(path.join(path.dirname(s.settings), readdirSync(path.dirname(s.settings)).find(name => name.includes('deck-backup-')))), originalBytes)
    assert.equal(s.run(action).status, 0)
    assert.deepEqual(readFileSync(s.settings), updated)
    if (action === 'init') assert.match(s.run('doctor').stdout, /hooks: ok/)
    const opaqueEvents = { hooks: { WorktreeCreate: { vendorField: true }, WorktreeRemove: 'vendor-owned' } }
    const transformed = transformHooks(opaqueEvents, installed, action === 'uninstall-hooks')
    for (const event of ['WorktreeCreate', 'WorktreeRemove']) assert.deepEqual(transformed.hooks[event], opaqueEvents.hooks[event])
  }
})

posixTest('dry run reports pending changes without exposing settings secrets', { skip: SYSTEMD_ONLY }, () => {
  const s = sandbox()
  const secret = 'sentinel-service-api-key-7f3e'
  writeFileSync(s.settings, JSON.stringify({ env: { SERVICE_API_KEY: secret } }))
  const result = s.run('init', '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /settings: would update/)
  assert.match(result.stdout, /fleetmates-deck\.service: would write/)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret))
})

posixTest('init writes the hub version beside the installed hook so the installed copy stamps it', async () => {
  // Task 23: init copies only deck-hook.mjs, whose version comes from ../package.json, so init also
  // writes <share>/package.json holding just the hub version.
  const s = sandbox('empty.json', { isolatedHub: true })
  const hubPackage = path.join(s.hubPath, 'package.json')
  const version = JSON.parse(readFileSync(hubPackage, 'utf8')).version
  const paths = setupPaths(s.env)
  const versionFile = path.join(paths.share, 'package.json')
  const dryRun = s.run('init', '--dry-run')
  assert.equal(dryRun.status, 0, dryRun.stderr)
  assert.ok(dryRun.stdout.includes(`hook version: ${versionFile} (would write)`), dryRun.stdout)
  assert.equal(existsSync(versionFile), false, 'dry run writes nothing')
  const stamp = async tag => (await import(`${pathToFileURL(paths.hook).href}?${tag}`))
    .makeEnvelope({ session_id: 's', cwd: '/home/you/dev/x', hook_event_name: 'Stop', stop_hook_active: false }, { hookTs: 1, ptyId: null }).deckHookVersion
  const first = s.run('init')
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(JSON.parse(readFileSync(versionFile, 'utf8')), { version })
  assert.equal(statSync(versionFile).mode & 0o777, 0o600)
  assert.equal(await stamp('first'), version)
  const unchanged = s.run('init', '--dry-run')
  assert.ok(unchanged.stdout.includes(`hook version: ${versionFile} (unchanged)`), unchanged.stdout)
  writeFileSync(hubPackage, JSON.stringify({ ...JSON.parse(readFileSync(hubPackage, 'utf8')), version: '9.8.7' }))
  const second = s.run('init')
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(JSON.parse(readFileSync(versionFile, 'utf8')), { version: '9.8.7' })
  assert.equal(statSync(versionFile).mode & 0o777, 0o600)
  assert.equal(await stamp('second'), '9.8.7')
})

posixTest('init merges hooks, preserves existing order and is byte identical twice', { skip: SYSTEMD_ONLY }, () => {
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

posixTest('settings replacement is atomic and preserves originals through interrupted writes', { concurrency: false }, () => {
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

posixTest('init rotate token replaces the token and keeps private file mode', () => {
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

posixTest('init skips the absent web entry and starts it after installation', { skip: SYSTEMD_ONLY }, () => {
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

posixTest('fresh home without settings.json installs hooks without a backup', () => {
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

posixTest('changed web unit triggers try-restart only for web while active', { skip: SYSTEMD_ONLY }, () => {
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

posixTest('uninstall removes deck hooks and keeps other hook entries', () => {
  const s = sandbox('existing-hooks.json')
  assert.equal(s.run('init').status, 0)
  assert.equal(s.run('uninstall-hooks').status, 0)
  const parsed = JSON.parse(readFileSync(s.settings))
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, 'node /home/you/fleetmates-hook.mjs')
  assert.equal(parsed.hooks.SessionStart[0].hooks[0].command, 'node /home/you/existing-hook.mjs')
  assert.equal(Object.values(parsed.hooks).flatMap(groups => groups.flatMap(group => group.hooks)).some(h => h.command?.includes('deck-hook.mjs')), false)
})

posixTest('open uses a private bootstrap file after identity proof and reaches the deck', { skip: SYSTEMD_ONLY }, async () => {
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
  } finally { await stopListener(server.child) }
})

posixTest('open uses validated DECK_PORT ahead of config port', { skip: SYSTEMD_ONLY }, async () => {
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
  } finally { await stopListener(server.child) }
})

posixTest('open refuses a loopback listener without the token proof', { skip: SYSTEMD_ONLY }, async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, false)
  try {
    const result = s.run('open')
    assert.equal(result.status, 1)
    assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /xdg-open:/)
    assert.equal(readFileSync(server.requestFile, 'utf8').includes(token), false)
  } finally { await stopListener(server.child) }
})

posixTest('open rejects an identity relay to another port before exposing the token', { skip: SYSTEMD_ONLY }, async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const trusted = await listener(s, token, true)
  let relay
  try {
    relay = await listener(s, '', true, 0, { relayPort: trusted.port })
    assert.notEqual(relay.port, trusted.port)
    writeFileSync(s.calls, '')
    const rejected = s.run('open')
    assert.equal(rejected.status, 1, rejected.stderr)
    assert.match(rejected.stderr, /deck identity proof failed/)
    const request = readFileSync(relay.requestFile, 'utf8')
    assert.match(request, /^\/\.well-known\/fleetmates-deck\/identity\?nonce=[A-Za-z0-9_-]{32}$/)
    assert.equal(readFileSync(trusted.requestFile, 'utf8'), request)
    assert.equal(request.includes(token), false)
    assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /xdg-open:/)
    assert.equal(existsSync(path.join(s.state, 'fleetmates/deck/open.html')), false)
    assert.equal(readdirSync(path.join(s.state, 'fleetmates/deck')).some(name => name.startsWith('.open-')), false)
    assert.doesNotMatch(rejected.stdout + rejected.stderr, new RegExp(token))
    writeFileSync(path.join(s.config, 'fleetmates/deck/config.json'), JSON.stringify({ port: trusted.port }))
    const accepted = s.run('open')
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(readFileSync(s.calls, 'utf8'), /xdg-open:/)
    assert.ok(readFileSync(path.join(s.state, 'fleetmates/deck/open.html'), 'utf8').includes(`http://127.0.0.1:${trusted.port}/#token=${token}`))
    assert.doesNotMatch(accepted.stdout + accepted.stderr, new RegExp(token))
  } finally {
    if (relay) await stopListener(relay.child)
    await stopListener(trusted.child)
  }
})

posixTest('open refuses the old nonce-only identity proof', { skip: SYSTEMD_ONLY }, async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, true, 0, { legacyProof: true })
  try {
    const result = s.run('open')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /deck identity proof failed/)
    assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /xdg-open:/)
    assert.equal(existsSync(path.join(s.state, 'fleetmates/deck/open.html')), false)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token))
  } finally { await stopListener(server.child) }
})

posixTest('open waits for a valid listener after systemctl start returns', { skip: SYSTEMD_ONLY }, async () => {
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
  } finally { await stopListener(server.child) }
})

posixTest('open stops retrying when no listener appears', { skip: SYSTEMD_ONLY }, async () => {
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
  } finally { await stopListener(server.child) }
})

posixTest('open launches the default web browser entry, not the text/html handler, with only the file path', { skip: SYSTEMD_ONLY }, async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, true)
  try {
    writeFileSync(s.calls, '')
    const result = s.runWith({ DECK_TEST_DEFAULT_BROWSER: 'chromium.desktop', DECK_TEST_GTK_LAUNCH: '0' }, 'open')
    assert.equal(result.status, 0, result.stderr)
    const bootstrap = path.join(s.state, 'fleetmates/deck/open.html')
    const launches = readFileSync(s.calls, 'utf8').trim().split('\n').filter(line => !line.startsWith('systemctl:'))
    assert.deepEqual(launches, ['xdg-settings:get default-web-browser', `gtk-launch:chromium.desktop ${bootstrap}`])
    assert.ok(readFileSync(bootstrap, 'utf8').includes(token))
    assert.equal(readFileSync(s.calls, 'utf8').includes(token), false)

    writeFileSync(s.calls, '')
    const viaBrowser = s.runWith({ BROWSER: 'deck-test-browser', DECK_TEST_DEFAULT_BROWSER: 'chromium.desktop', DECK_TEST_GTK_LAUNCH: '0' }, 'open')
    assert.equal(viaBrowser.status, 0, viaBrowser.stderr)
    const order = readFileSync(s.calls, 'utf8').trim().split('\n').filter(line => !line.startsWith('systemctl:'))
    assert.deepEqual(order, [`deck-test-browser:${bootstrap}`, 'xdg-settings:get default-web-browser', `gtk-launch:chromium.desktop ${bootstrap}`], '$BROWSER is tried first')
  } finally { await stopListener(server.child) }
})

posixTest('open prints the bootstrap file path and fails when no launcher works', { skip: SYSTEMD_ONLY }, async () => {
  const s = sandbox('empty.json', { webEntry: true })
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  const server = await listener(s, token, true)
  try {
    const result = s.runWith({ DECK_TEST_XDG_OPEN_STATUS: '1' }, 'open')
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(path.join(s.state, 'fleetmates/deck/open.html')), result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token))
  } finally { await stopListener(server.child) }
})

posixTest('init probes the active deckd socket for readiness before its deckd check', { skip: SYSTEMD_ONLY }, async () => {
  const s = sandbox()
  const paths = setupPaths(s.env)
  mkdirSync(paths.runtime, { recursive: true })
  // Each connection records whether it asked for anything: the readiness wait connects and closes,
  // the doctor probe says hello. Without the wait there is only the hello connection.
  const connections = []
  const server = createServer(socket => {
    const entry = { ops: [] }
    connections.push(entry)
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        entry.ops.push(message.op)
        socket.write(`${JSON.stringify({ id: message.id, ok: true })}\n`)
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve, reject) => server.listen(path.join(paths.runtime, 'deckd.sock'), resolve).once('error', reject))
  try {
    const child = spawn(process.execPath, [path.join(s.hubPath, 'bin/fleetmates-deck.mjs'), 'init'], { env: { ...s.env, DECK_TEST_DECKD_ACTIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0)
    assert.match(stdout, /^deckd: ok \(deckd running\)$/m)
    assert.deepEqual(connections.map(entry => entry.ops), [[], ['hello']])
  } finally { await new Promise(resolve => server.close(resolve)) }
})

posixTest('doctor and init show a newer Claude Code as a warning that does not fail the exit code', () => {
  const s = sandbox()
  const newer = { DECK_TEST_CLAUDE_VERSION: newerVersion() }
  const init = s.runWith(newer, 'init')
  assert.equal(init.status, 0, init.stderr)
  assert.ok(init.stdout.split('\n').includes(`claude: warn (Claude Code ${newerVersion()} is newer than this deck was tested with (${testedVersion()}))`), init.stdout)
  const doctor = s.runWith(newer, 'doctor')
  assert.equal(doctor.status, 0)
  assert.match(doctor.stdout, /^claude: warn /m)
  assert.match(doctor.stdout, /^hooks: ok /m)
})

posixTest('invalid settings stops init before it writes directories or services', () => {
  const s = sandbox()
  writeFileSync(s.settings, '{ broken')
  assert.equal(s.run('init').status, 1)
  assert.equal(readFileSync(s.settings, 'utf8'), '{ broken')
  assert.equal(readdirSync(s.config).length, 0)
  assert.equal(readdirSync(s.state).length, 0)
  assert.equal(readdirSync(s.root).includes('calls'), false)
})

posixTest('init updates an old deck hook in place', () => {
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

posixTest('renamed Node init is idempotent and uninstall preserves unrelated groups', t => {
  const s = sandbox('existing-hooks.json')
  const executableDir = fs.realpathSync.native(mkdtempSync(path.join('/var/tmp', 'deck-node-test-')))
  const executable = path.join(executableDir, 'deck-node-runtime')
  t.after(() => fs.rmSync(executableDir, { recursive: true, force: true }))
  try {
    fs.linkSync(process.execPath, executable)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_FICLONE)
  }
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

posixTest('legacy node and nodejs hooks merge once and uninstall without removing other commands', () => {
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

posixTest('init replaces an old hub path hook and preserves unrelated commands', () => {
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

posixTest('uninstall removes an old hub path hook and preserves unrelated commands', () => {
  const s = sandbox()
  const old = 'node /tmp/old-install/hub/hook/deck-hook.mjs'
  const unrelated = ['node /home/you/other/hook/deck-hook.mjs', 'echo /tmp/old-install/hub/hook/deck-hook.mjs', 'node\n/tmp/old-install/hub/hook/deck-hook.mjs', 'node /home/you/other.mjs']
  writeFileSync(s.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [old, ...unrelated].map(command => ({ type: 'command', command })) }] } }))
  assert.equal(s.run('uninstall-hooks').status, 0)
  const groups = JSON.parse(readFileSync(s.settings)).hooks.PreToolUse
  assert.deepEqual(groups[0].hooks.map(hook => hook.command), unrelated)
})

posixTest('restricted old hook gains wildcard coverage without widening unrelated hooks', () => {
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

posixTest('doctor and status read setup state without service mutations', { skip: SYSTEMD_ONLY }, () => {
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
  assert.equal(summary.claudeVersion, testedVersion())
  assert.equal(summary.testedClaudeVersion, testedVersion())
  assert.equal(summary.livePtys, 0)
  const serviceCalls = readFileSync(s.calls, 'utf8').trim().split('\n').filter(call => call.startsWith('systemctl:'))
  assert.deepEqual(serviceCalls, [
    'systemctl:--user is-active --quiet fleetmates-deckd.service',
    'systemctl:--user is-active --quiet fleetmates-deckd.service',
    'systemctl:--user is-active --quiet fleetmates-deck.service'
  ])
})

for (const stall of ['hello', 'list', null]) {
  posixTest(`setup socket probe ${stall ? `bounds stalled ${stall}` : 'reads a responsive daemon'}`, async () => {
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
            assert.equal(message.proto, PROTO)
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

/**
 * Run doctor against a fake deckd whose hello answers `hello`, and return the deckd check.
 * @param {object} hello fields of the hello answer
 */
async function deckdCheckWith(hello) {
  const s = sandbox()
  const paths = setupPaths(s.env)
  mkdirSync(paths.runtime, { recursive: true })
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        socket.write(`${JSON.stringify({ id: message.id, ok: true, ...(message.op === 'hello' ? hello : {}) })}\n`)
      }
    })
  })
  await new Promise((resolve, reject) => server.listen(path.join(paths.runtime, 'deckd.sock'), resolve).once('error', reject))
  try {
    const checks = await doctor(paths, 'unused', { run: file => ({ status: 0, stdout: file === 'claude' ? '2.1.282' : 'active' }) })
    return checks.find(check => check.id === 'deckd')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

posixTest('doctor names the login environment variables deckd adds, never their values', async () => {
  const check = await deckdCheckWith({ proto: 2, deckdVersion: '0.2.0', bootId: 'b', loginEnvNames: ['PATH', 'MISE_SHELL'] })
  assert.equal(check.state, 'ok')
  assert.equal(check.detail, 'login env adds 2 names: MISE_SHELL, PATH')
  assert.doesNotMatch(check.detail, /=/)
})

posixTest('doctor prints only loginEnvNames entries shaped like a variable name', async () => {
  const check = await deckdCheckWith({ proto: 2, deckdVersion: '0.2.0', bootId: 'b', loginEnvNames: ['MISE_SHELL', 'PATH=/home/you/bin', 'PATH', 7] })
  assert.equal(check.detail, 'login env adds 2 names: MISE_SHELL, PATH')
  assert.doesNotMatch(check.detail, /home\/you|=/)
})

posixTest('doctor keeps the deckd detail for an empty login env list and names the upgrade for a proto 1 deckd', async () => {
  assert.equal((await deckdCheckWith({ proto: 2, deckdVersion: '0.2.0', bootId: 'b', loginEnvNames: [] })).detail, 'deckd running')
  const old = await deckdCheckWith({ proto: 1, deckdVersion: '0.1.0', bootId: 'b' })
  assert.equal(old.state, 'ok')
  assert.equal(old.detail, 'deckd running; login env names need deckd 0.2.0')
})

posixTest('doctor fails when the configured hook script is missing or not a file', () => {
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

posixTest('doctor fails when the configured hook script is unreadable', () => {
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

posixTest('doctor finds the scribed Unix listener in the runtime directory', async () => {
  const s = sandbox()
  const server = createServer(socket => socket.end())
  await new Promise((resolve, reject) => server.listen(path.join(s.runtime, 'turbidassist.sock'), resolve).once('error', reject))
  try {
    const checks = await doctor(setupPaths(s.env, { platform: 'linux' }), 'unused', { platform: 'linux', run: file => file === 'claude' ? { status: 0, stdout: '2.1.282' } : { status: 3 } })
    assert.equal(checks.find(check => check.id === 'scribed').state, 'ok')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

posixTest('installed units use absolute Node and hub paths with private umask', { skip: SYSTEMD_ONLY }, () => {
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

posixTest('installed hook command runs from an XDG data directory with spaces', () => {
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

posixTest('both unit templates quote executable and entry paths with spaces', () => {
  const nodePath = '/tmp/node install/bin/node'
  const hubPath = '/tmp/deck review home/hub'
  for (const [name, entry] of [['fleetmates-deck.service', 'server/main.mjs'], ['fleetmates-deckd.service', 'deckd/main.mjs']]) {
    const rendered = renderUnit(name, nodePath, hubPath)
    assert.ok(rendered.includes(`ExecStart="${nodePath}" "${hubPath}/${entry}"`))
    if (name === 'fleetmates-deck.service') assert.ok(rendered.split('\n').includes(`ConditionPathExists=${hubPath}/${entry}`))
    assert.equal(rendered.includes('@NODE@') || rendered.includes('@ENTRY@'), false)
  }
})

// The next two tests run in this order: the first leaves its listener running, as a failing test would.
let abandoned
posixTest('a test may stop early and leave its listener running', async () => {
  const s = sandbox()
  mkdirSync(path.join(s.config, 'fleetmates/deck'), { recursive: true })
  abandoned = await listener(s, 'token', true)
  assert.equal(abandoned.child.exitCode, null, 'the listener is up when its test ends')
})

posixTest('every listener a test started has exited before the next test runs, including an abandoned one', () => {
  assert.ok(abandoned, 'the previous test started a listener')
  assert.ok(startedListeners.length >= 9, `the earlier tests started listeners: ${startedListeners.length}`)
  const alive = startedListeners.filter(child => child.exitCode === null && child.signalCode === null)
  assert.deepEqual(alive.map(child => child.pid), [], 'no listener outlives its test')
})

posixTest('a listener exits on its own when the process that started it goes away', async () => {
  const s = sandbox()
  mkdirSync(path.join(s.config, 'fleetmates/deck'), { recursive: true })
  const { child } = await listener(s, 'token', true)
  const exited = once(child, 'exit')
  // Closing its stdin is what the listener sees when the test process dies without running any cleanup.
  child.stdin.end()
  let timer
  const outcome = await Promise.race([exited.then(() => 'exited'), new Promise(resolve => { timer = setTimeout(() => resolve('still running'), 3000) })])
  clearTimeout(timer)
  assert.equal(outcome, 'exited')
})

posixTest('each deck-setup sandbox is removed once the test that made it finishes', () => {
  const current = sandbox()
  assert.ok(sandboxRoots.length > 1, 'the earlier tests in this file created sandboxes')
  const left = sandboxRoots.filter(root => root !== current.root && existsSync(root))
  assert.deepEqual(left, [])
  assert.ok(existsSync(current.root), 'a sandbox stays while its own test runs')
})

// Injected-platform tests: setupPaths, doctor and status for linux, darwin and win32, with placeholder paths and
// injected run, service, exists and readFile functions. They touch no real service manager and run on any host.

test('setupPaths on linux keeps the XDG layout and adds runtime and endpoints under XDG_RUNTIME_DIR', () => {
  const paths = setupPaths({ HOME: '/home/you', XDG_RUNTIME_DIR: '/run/user/1000' }, { platform: 'linux', uid: 1000 })
  assert.deepEqual(paths, {
    home: '/home/you',
    config: '/home/you/.config/fleetmates/deck',
    state: '/home/you/.local/state/fleetmates/deck',
    share: '/home/you/.local/share/fleetmates-deck',
    spool: '/home/you/.local/state/fleetmates/deck/spool',
    logs: '/home/you/.local/state/fleetmates/deck/logs',
    token: '/home/you/.local/state/fleetmates/deck/token',
    hook: '/home/you/.local/share/fleetmates-deck/hook/deck-hook.mjs',
    settings: '/home/you/.claude/settings.json',
    units: '/home/you/.config/systemd/user',
    runtime: '/run/user/1000/fleetmates-deck',
    endpoints: { deckd: '/run/user/1000/fleetmates-deck/deckd.sock', hooks: '/run/user/1000/fleetmates-deck/hooks.sock' }
  })
})

test('setupPaths on linux without XDG_RUNTIME_DIR has a runtime dir and endpoints under /tmp, never null', () => {
  const paths = setupPaths({ HOME: '/home/you' }, { platform: 'linux', uid: 1000 })
  assert.equal(paths.runtime, '/tmp/fleetmates-deck-1000/fleetmates-deck')
  assert.deepEqual(paths.endpoints, { deckd: '/tmp/fleetmates-deck-1000/fleetmates-deck/deckd.sock', hooks: '/tmp/fleetmates-deck-1000/fleetmates-deck/hooks.sock' })
})

test('setupPaths on darwin keeps the XDG layout, runs from Library/Caches and puts units in LaunchAgents', () => {
  const paths = setupPaths({ HOME: '/Users/you' }, { platform: 'darwin', uid: 501 })
  assert.equal(paths.config, '/Users/you/.config/fleetmates/deck')
  assert.equal(paths.state, '/Users/you/.local/state/fleetmates/deck')
  assert.equal(paths.share, '/Users/you/.local/share/fleetmates-deck')
  assert.equal(paths.units, '/Users/you/Library/LaunchAgents')
  assert.equal(paths.runtime, '/Users/you/Library/Caches/fleetmates-deck/fleetmates-deck')
  assert.equal(paths.endpoints.deckd, '/Users/you/Library/Caches/fleetmates-deck/fleetmates-deck/deckd.sock')
  const xdg = setupPaths({ HOME: '/Users/you', XDG_CONFIG_HOME: '/Users/you/cfg', XDG_RUNTIME_DIR: '/Users/you/run' }, { platform: 'darwin', uid: 501 })
  assert.equal(xdg.config, '/Users/you/cfg/fleetmates/deck')
  assert.equal(xdg.units, '/Users/you/Library/LaunchAgents', 'launchd reads LaunchAgents whatever XDG_CONFIG_HOME says')
  assert.equal(xdg.runtime, '/Users/you/run/fleetmates-deck')
})

const WIN_ENV = { USERPROFILE: 'C:\\Users\\you', APPDATA: 'C:\\Users\\you\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local' }
const PIPE = /^\\\\\.\\pipe\\fleetmates-deck-[0-9a-f]{16}-(deckd|hooks)$/

test('setupPaths on win32 puts config under APPDATA, state and share under LOCALAPPDATA, and the endpoints on named pipes', () => {
  const paths = setupPaths(WIN_ENV, { platform: 'win32', uid: null })
  assert.equal(paths.home, 'C:\\Users\\you')
  assert.equal(paths.config, 'C:\\Users\\you\\AppData\\Roaming\\fleetmates\\deck')
  assert.equal(paths.state, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\state')
  assert.equal(paths.share, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\share')
  assert.equal(paths.spool, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\state\\spool')
  assert.equal(paths.logs, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\state\\logs')
  assert.equal(paths.token, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\state\\token')
  assert.equal(paths.hook, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\share\\hook\\deck-hook.mjs')
  assert.equal(paths.settings, 'C:\\Users\\you\\.claude\\settings.json')
  assert.equal(paths.units, null)
  assert.equal(paths.runtime, 'C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run\\fleetmates-deck')
  assert.match(paths.endpoints.deckd, PIPE)
  assert.match(paths.endpoints.hooks, PIPE)
  assert.ok(paths.endpoints.deckd.endsWith('-deckd') && paths.endpoints.hooks.endsWith('-hooks'))
  assert.equal(paths.endpoints.deckd.replace(/-deckd$/, ''), paths.endpoints.hooks.replace(/-hooks$/, ''), 'both pipes share one hash')
})

test('setupPaths on win32 falls back to the profile AppData folders, never ~/.config, and lets set XDG variables win', () => {
  const bare = setupPaths({ USERPROFILE: 'C:\\Users\\you' }, { platform: 'win32', uid: null })
  assert.equal(bare.config, 'C:\\Users\\you\\AppData\\Roaming\\fleetmates\\deck')
  assert.equal(bare.state, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\state')
  assert.equal(bare.share, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\share')
  for (const value of [bare.config, bare.state, bare.share]) assert.doesNotMatch(value, /\.config|\.local/)
  const xdg = setupPaths({ ...WIN_ENV, XDG_CONFIG_HOME: 'D:\\xdg\\config', XDG_STATE_HOME: 'D:\\xdg\\state', XDG_DATA_HOME: 'D:\\xdg\\data', XDG_RUNTIME_DIR: 'D:\\xdg\\run' }, { platform: 'win32', uid: null })
  assert.equal(xdg.config, 'D:\\xdg\\config\\fleetmates\\deck')
  assert.equal(xdg.state, 'D:\\xdg\\state\\fleetmates\\deck')
  assert.equal(xdg.share, 'D:\\xdg\\data\\fleetmates-deck')
  assert.equal(xdg.runtime, 'D:\\xdg\\run\\fleetmates-deck')
  assert.match(xdg.endpoints.deckd, PIPE)
  assert.notEqual(xdg.endpoints.deckd, setupPaths(WIN_ENV, { platform: 'win32', uid: null }).endpoints.deckd, 'another runtime base gives another pipe')
})

/** A recording spawnSync-shaped `run`: claude answers `claudeOut`, systemctl answers `systemctlStatus`. */
function recordingRun({ claudeOut = `${testedVersion()} (Claude Code)\n`, systemctlStatus = 3 } = {}) {
  const calls = []
  const run = (file, args, options) => {
    calls.push({ file, args, options })
    if (file === 'systemctl') return { status: systemctlStatus, stdout: '', stderr: '' }
    return { status: 0, stdout: claudeOut, stderr: '' }
  }
  return { calls, run }
}

/** A recording service adapter. */
function fakeService(kind, active = () => false) {
  const asked = []
  return { asked, service: { kind, isActive: async name => { asked.push(name); return active(name) } } }
}

const checkById = (checks, id) => checks.find(check => check.id === id)

test('doctor on linux asks the systemd adapter whether deckd is active and keeps the scribed and notify checks', async () => {
  const paths = setupPaths({ HOME: '/home/you', XDG_RUNTIME_DIR: '/nonexistent-deck-test-runtime' }, { platform: 'linux', uid: 1000 })
  const { calls, run } = recordingRun()
  const checks = await doctor(paths, 'cmd', { platform: 'linux', run, env: {} })
  assert.deepEqual(calls.map(call => [call.file, ...call.args]), [['claude', '--version'], ['systemctl', '--user', 'is-active', '--quiet', 'fleetmates-deckd.service']])
  assert.deepEqual(calls[0].options, {}, 'claude runs through commandSpawn, whose POSIX options are empty')
  assert.equal(checkById(checks, 'claude').state, 'ok')
  assert.deepEqual(checkById(checks, 'deckd'), { id: 'deckd', state: 'failed', blocking: false, detail: 'deckd unavailable' })
  assert.deepEqual(checkById(checks, 'scribed'), { id: 'scribed', state: 'optional_skipped', blocking: false, detail: 'scribed socket optional' })
  assert.deepEqual(checkById(checks, 'notify'), { id: 'notify', state: 'pending', blocking: false, detail: 'Send a test ping from Settings' })
})

test('doctor on darwin never runs systemctl: deckd comes from the launchd adapter probe, scribed is unsupported', async () => {
  const paths = setupPaths({ HOME: '/Users/you' }, { platform: 'darwin', uid: 501 })
  const { calls, run } = recordingRun({ systemctlStatus: 0 })
  const checks = await doctor(paths, 'cmd', { platform: 'darwin', run, env: {} })
  assert.deepEqual(calls.map(call => call.file), ['claude'], 'no systemctl and no launchctl for a read-only check')
  assert.equal(checkById(checks, 'deckd').state, 'failed', 'nothing listens on the darwin endpoint')
  assert.deepEqual(checkById(checks, 'scribed'), { id: 'scribed', state: 'optional_skipped', blocking: false, detail: 'unsupported on darwin' })
  assert.equal(checkById(checks, 'notify').state, 'pending')

  const { asked, service } = fakeService('launchd')
  const injected = recordingRun({ systemctlStatus: 0 })
  await doctor(paths, 'cmd', { platform: 'darwin', run: injected.run, env: {}, service })
  assert.deepEqual(asked, ['deckd'])
  assert.deepEqual(injected.calls.map(call => call.file), ['claude'])
})

test('doctor on win32 resolves claude.cmd on PATH, runs its unwrapped exe hidden, and reports win32 limits', async () => {
  const paths = setupPaths(WIN_ENV, { platform: 'win32', uid: null })
  const { calls, run } = recordingRun()
  const shim = '@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
  const checks = await doctor(paths, 'cmd', {
    platform: 'win32', run,
    env: { PATH: 'C:\\Users\\you\\AppData\\Roaming\\npm', PATHEXT: '.EXE;.CMD' },
    exists: file => file === 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd',
    readFile: file => { assert.equal(file, 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd'); return shim }
  })
  assert.deepEqual(calls, [{ file: 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', args: ['--version'], options: { windowsHide: true } }])
  assert.equal(checkById(checks, 'claude').state, 'ok')
  assert.equal(checkById(checks, 'deckd').state, 'failed')
  assert.deepEqual(checkById(checks, 'scribed'), { id: 'scribed', state: 'optional_skipped', blocking: false, detail: 'unsupported on win32' })
  assert.deepEqual(checkById(checks, 'notify'), { id: 'notify', state: 'optional_skipped', blocking: false, detail: 'in-tab only on win32' })
})

test('status names the services per adapter and asks the adapter, not systemctl, off linux', async () => {
  for (const [platform, kind, names] of [['darwin', 'launchd', ['io.fleetmates.deck.deckd', 'io.fleetmates.deck.web']], ['win32', 'detached', ['deckd', 'web']]]) {
    const paths = platform === 'win32' ? setupPaths(WIN_ENV, { platform, uid: null }) : setupPaths({ HOME: '/Users/you' }, { platform, uid: 501 })
    const { asked, service } = fakeService(kind, name => name === 'web')
    const { calls, run } = recordingRun({ systemctlStatus: 0 })
    const summary = await status(paths, 'cmd', { platform, run, env: {}, service, exists: () => false })
    assert.deepEqual(summary.units, [{ name: names[0], active: false }, { name: names[1], active: true }], platform)
    assert.deepEqual(asked, ['deckd', 'web'], platform)
    assert.deepEqual(calls.map(call => call.file), ['claude'], platform)
    assert.equal(summary.socket, false, platform)
  }
})

posixTest('start and stop run the service adapter for both services, and refuse extra arguments', { skip: SYSTEMD_ONLY }, () => {
  const s = sandbox()
  const start = s.run('start')
  assert.equal(start.status, 0, start.stderr)
  assert.deepEqual(readFileSync(s.calls, 'utf8').trim().split('\n'), ['systemctl:--user start fleetmates-deckd.service', 'systemctl:--user start fleetmates-deck.service'])
  writeFileSync(s.calls, '')
  const stop = s.run('stop')
  assert.equal(stop.status, 0, stop.stderr)
  assert.deepEqual(readFileSync(s.calls, 'utf8').trim().split('\n'), ['systemctl:--user stop fleetmates-deck.service', 'systemctl:--user stop fleetmates-deckd.service'])
  writeFileSync(s.calls, '')
  for (const args of [['start', 'deckd'], ['stop', '--now']]) {
    const refused = s.run(...args)
    assert.equal(refused.status, 1, args.join(' '))
    assert.match(refused.stderr, /usage: fleetmates-deck .*\| start \| stop \|/)
  }
  assert.equal(readFileSync(s.calls, 'utf8'), '', 'a refused command touches no service')
})
