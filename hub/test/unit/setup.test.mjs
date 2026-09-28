import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

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
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}:'"$*" >> "$DECK_TEST_CALLS"\nif [ '${name}' = claude ]; then echo '2.1.282 (Claude Code)'; fi\nif [ '${name}' = systemctl ] && [ "$2" = is-active ]; then exit 3; fi\n`)
    execFileSync('chmod', ['700', file])
  }
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(root, 'data'), XDG_RUNTIME_DIR: runtime, PATH: `${bin}:${process.env.PATH}`, DECK_TEST_CALLS: calls, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' })
  return { root, home, config, state, runtime, calls, settings, run }
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
  assert.equal(readdirSync(path.dirname(s.settings)).filter(name => name.includes('deck-backup-')).length, 1)
  assert.equal(statSync(path.join(s.state, 'fleetmates/deck/token')).mode & 0o777, 0o600)
  assert.equal(readFileSync(s.calls, 'utf8').includes('restart fleetmates-deckd'), false)
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

test('open starts the web unit and passes the token only in the browser URL', () => {
  const s = sandbox()
  assert.equal(s.run('init').status, 0)
  const token = readFileSync(path.join(s.state, 'fleetmates/deck/token'), 'utf8').trim()
  assert.equal(s.run('open').status, 0)
  const calls = readFileSync(s.calls, 'utf8')
  assert.match(calls, /systemctl:--user start fleetmates-deck.service/)
  assert.ok(calls.includes(`xdg-open:http://127.0.0.1:47800/#token=${token}`))
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
  assert.match(groups[0].hooks[0].command, /fleetmates-deck\/hook\/deck-hook\.mjs$/)
  assert.equal(groups[0].hooks[1].command, 'node /home/you/other.mjs')
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
  assert.ok(deckd.includes(`ExecStart=${process.execPath} ${hub}/deckd/main.mjs`))
  assert.ok(web.includes(`ExecStart=${process.execPath} ${hub}/server/main.mjs`))
  assert.match(deckd, /UMask=0077/)
  assert.match(web, /UMask=0077/)
})
