import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startDeckServer } from '../../server/main.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { makeRuntimeDir } from './runtime-dir.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

export const token = 'v'.repeat(43)
const worker = '02-wiki/nestjs/bullmq-worker.md'
export async function memoryHarness (t, mode = 'ok', { web, fixture = 'answer-cited', delay = '30', askTimers, scenario, vaultCommand, prepareVault, pty = false, transformAsk = args => args } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-api-'))
  const vault = path.join(home, 'vault')
  let bin, daemon, runtime, deck, locked = false
  // Registered before anything that can throw; the server and deckd close before their directories are removed.
  t.after(async () => { await deck?.close(); await daemon?.close(); await runtime?.cleanup(); if (locked) await fs.chmod(vault, 0o700)
    await bin?.cleanup(); await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  bin = await fakeBin()
  if (pty) runtime = await makeRuntimeDir()
  // The environment the server gets; the token and config.json go where the server reads them on this platform.
  const env = { HOME: home, PATH: bin.env.PATH, XDG_RUNTIME_DIR: runtime?.dir ?? home }
  const { state, config } = setupPaths(env)
  await fs.mkdir(state, { recursive: true })
  await fs.mkdir(config, { recursive: true })
  await fs.mkdir(vault)
  await prepareVault?.(vault)
  await fs.writeFile(path.join(state, 'token'), token, { mode: 0o600 })
  await fs.writeFile(path.join(config, 'config.json'), JSON.stringify({ vaultPath: vault,
    vaultCommand: vaultCommand ?? [process.execPath, fileURLToPath(new URL('../fakes/fake-vault-mcp.mjs', import.meta.url))],
    claudeCommand: bin.claudePath, lang: 'en', obsidianVaultName: 'Test vault' }))
  const scenarioFile = scenario ? path.join(home, 'scenario.json') : undefined
  if (scenario) await fs.writeFile(scenarioFile, JSON.stringify(scenario))
  const opened = [], events = [], askSpawns = []
  const vaultLog = path.join(home, 'vault.log')
  if (pty) {
    const script = path.join(home, 'research-script.json')
    await fs.writeFile(script, JSON.stringify({ sessionId: 'auto', steps: [{ frame: 'idle-input' }, { expectInput: { match: 'Research this topic as a fleetmates team', timeoutMs: 10000 } }, { hang: true }] }))
    daemon = await startDeckd({ runtimeDir: runtime.dir, loginEnv: { PATH: bin.env.PATH, HOME: home, XDG_RUNTIME_DIR: runtime.dir, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_VERSION: '2.1.285' } })
  }
  deck = await startDeckServer({ port: 0, staticDir: web, env,
    askTimers, notifications: false, runPollMs: 3_600_000, connectDeckd: pty ? connectDeckd : async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
    services: { open: async target => opened.push(target) },
    vaultSpawn: (file, args, options) => spawn(file, args, { ...options, env: { ...options.env, FAKE_VAULT_MODE: typeof mode === 'function' ? mode() : mode, FAKE_VAULT_SCENARIO: scenarioFile, FAKE_VAULT_LOG: vaultLog } }),
    askSpawn: (file, args, options) => { const argv = transformAsk(args); askSpawns.push(argv); return spawn(file, argv, { ...options, env: { ...options.env,
      FAKE_CLAUDE_P_FIXTURE: typeof fixture === 'function' ? fixture() : fixture, FAKE_CLAUDE_P_DELAY_MS: delay } }) } })
  deck.subscribe(event => events.push(event))
  if (!prepareVault) { await fs.chmod(vault, 0)
    locked = true }
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
