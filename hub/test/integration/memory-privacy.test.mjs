import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

test('child server keeps question and answer in thread tables only and thread deletion scrubs database bytes', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mpriv-'))
  let bin, child
  // Registered before anything that can throw; the server exits before its directory is removed.
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
    await bin?.cleanup(); await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  bin = await fakeBin()
  const fixture = path.join(home, 'answer.jsonl')
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const serverEnv = { HOME: home, PATH: bin.env.PATH, DECK_PORT: String(port), XDG_RUNTIME_DIR: home, FAKE_CLAUDE_P_FIXTURE: fixture }
  // Where the child server reads its state and config for this env on this platform.
  const { state, config } = setupPaths(serverEnv)
  await fs.mkdir(state, { recursive: true }); await fs.mkdir(config, { recursive: true })
  const token = 'p'.repeat(43), question = 'QUESTION_PRIVATE_SENTINEL', answer = 'ANSWER_PRIVATE_SENTINEL'
  await fs.writeFile(path.join(state, 'token'), token, { mode: 0o600 })
  await fs.writeFile(path.join(config, 'config.json'), JSON.stringify({ vaultPath: path.join(home, 'unreadable-vault'),
    vaultCommand: [process.execPath, fileURLToPath(new URL('../fakes/fake-vault-mcp.mjs', import.meta.url))], claudeCommand: bin.claudePath }))
  const original = await fs.readFile(new URL('../fixtures/claude-p/synthetic/no-block.jsonl', import.meta.url), 'utf8')
  const lines = original.trim().split('\n').map(line => JSON.parse(line))
  let sent = false
  for (const line of lines) {
    if (line.type === 'assistant') for (const block of line.message.content) if (block.type === 'text') block.text = answer
    if (line.type === 'result') line.result = answer
    if (line.event?.delta?.type === 'text_delta') { line.event.delta.text = sent ? '' : answer; sent = true }
  }
  await fs.writeFile(fixture, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  let logs = ''
  child = spawn(process.execPath, [fileURLToPath(new URL('../../server/main.mjs', import.meta.url))], {
    env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', chunk => { logs += chunk }); child.stderr.on('data', chunk => { logs += chunk })
  const base = `http://127.0.0.1:${port}`
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { Origin: base, Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return response.json()
  }
  const deadline = Date.now() + 7000
  while (true) { try { await request('/api/version'); break } catch { assert.ok(Date.now() < deadline, logs); await new Promise(resolve => setTimeout(resolve, 20)) } }
  const started = await request('/api/ask', 'POST', { text: question })
  assert.ok(started.thread?.id)
  let thread
  while (true) { thread = await request(`/api/threads/${started.thread.id}`); if (thread.messages?.[1]?.text === answer) break; assert.ok(Date.now() < deadline, logs); await new Promise(resolve => setTimeout(resolve, 20)) }
  const dbFile = path.join(state, 'deck.db'), db = new DatabaseSync(dbFile)
  try {
    const events = JSON.stringify(db.prepare('SELECT * FROM events').all())
    assert.equal(events.includes(question), false); assert.equal(events.includes(answer), false)
    assert.equal(logs.includes(question), false); assert.equal(logs.includes(answer), false)
    for (const name of await fs.readdir(path.join(state, 'spool'))) {
      const text = await fs.readFile(path.join(state, 'spool', name), 'utf8')
      assert.equal(text.includes(question), false); assert.equal(text.includes(answer), false)
    }
    const before = await fs.readFile(dbFile)
    assert.ok(before.includes(Buffer.from(question)) || (await fs.readFile(`${dbFile}-wal`)).includes(Buffer.from(question)))
    await request(`/api/threads/${started.thread.id}`, 'DELETE')
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    for (const file of [dbFile, `${dbFile}-wal`]) {
      const bytes = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error })
      assert.equal(bytes.includes(Buffer.from(question)), false); assert.equal(bytes.includes(Buffer.from(answer)), false)
    }
  } finally { db.close() }
})
