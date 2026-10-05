import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startDeckServer } from '../../server/main.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'

export const token = 'v'.repeat(43)
const worker = '02-wiki/nestjs/bullmq-worker.md'
export async function memoryHarness (t, mode = 'ok', { web, fixture = 'answer-cited', delay = '30', askTimers, scenario, transformAsk = args => args } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-api-'))
  const bin = await fakeBin()
  const state = path.join(home, '.local/state/fleetmates/deck')
  const config = path.join(home, '.config/fleetmates/deck')
  const vault = path.join(home, 'vault')
  await fs.mkdir(state, { recursive: true })
  await fs.mkdir(config, { recursive: true })
  await fs.mkdir(vault)
  await fs.writeFile(path.join(state, 'token'), token, { mode: 0o600 })
  await fs.writeFile(path.join(config, 'config.json'), JSON.stringify({ vaultPath: vault,
    vaultCommand: [process.execPath, fileURLToPath(new URL('../fakes/fake-vault-mcp.mjs', import.meta.url))],
    claudeCommand: path.join(bin.binDir, 'claude'), lang: 'en', obsidianVaultName: 'Test vault' }))
  const scenarioFile = scenario ? path.join(home, 'scenario.json') : undefined
  if (scenario) await fs.writeFile(scenarioFile, JSON.stringify(scenario))
  const opened = [], events = [], askSpawns = []
  const vaultLog = path.join(home, 'vault.log')
  const deck = await startDeckServer({ port: 0, staticDir: web, env: { HOME: home, PATH: bin.env.PATH, XDG_RUNTIME_DIR: home },
    askTimers, notifications: false, runPollMs: 3_600_000, connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
    services: { open: async target => opened.push(target) },
    vaultSpawn: (file, args, options) => spawn(file, args, { ...options, env: { ...options.env, FAKE_VAULT_MODE: typeof mode === 'function' ? mode() : mode, FAKE_VAULT_SCENARIO: scenarioFile, FAKE_VAULT_LOG: vaultLog } }),
    askSpawn: (file, args, options) => { const argv = transformAsk(args); askSpawns.push(argv); return spawn(file, argv, { ...options, env: { ...options.env,
      FAKE_CLAUDE_P_FIXTURE: typeof fixture === 'function' ? fixture() : fixture, FAKE_CLAUDE_P_DELAY_MS: delay } }) } })
  deck.subscribe(event => events.push(event))
  await fs.chmod(vault, 0)
  t.after(async () => { await deck.close(); await fs.chmod(vault, 0o700); await bin.cleanup(); await fs.rm(home, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${deck.address().port}`
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, Origin: base,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  return { deck, request, opened, events, home, base, askSpawns, vaultLog }
}
export async function waitFor (fn) {
  const deadline = Date.now() + 5000
  while (!fn()) { assert.ok(Date.now() < deadline, 'timed out waiting for ask'); await new Promise(resolve => setTimeout(resolve, 10)) }
  return fn()
}

