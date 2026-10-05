import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startDeckServer } from '../../server/main.mjs'

// D-92 (d): before Task 20, a Bash command named `constructor` made the classifier throw (a
// word-keyed table lookup reached Object.prototype), and the throw escaped the hook ingest: the
// first case below then failed at its first PermissionRequest and the second at the server start.
// These cases pin that the request is classified (Caution, an unknown command) and that the
// session keeps applying. The classify.error fallback for a classifier that still throws is pinned
// by machines.test.mjs, which injects a throwing classifier.
const token = 'a'.repeat(43)
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clt-'))
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const opts = { env, port: 0, staticDir, notifications: false, connectDeckd: async () => { throw Error('fake offline') }, runPollMs: 3_600_000,
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }) }
  let deck = null
  const envelope = (event, at, extra) => JSON.stringify({ v: 1, hookTs: at, ptyId: null, claudePid: null, pidChain: [], truncated: false,
    hook: { ...fixture, cwd: dir, hook_event_name: event, ...extra } })
  t.after(async () => {
    await deck?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return {
    state,
    envelope,
    get deck() { return deck },
    async start() { deck = await startDeckServer(opts) },
    async stop() {
      await deck.close()
      deck = null
    },
    send(event, at, extra = {}) {
      deck.ingest.receive(envelope(event, at, extra))
      deck.ingest.flush()
    },
    async request(route) {
      const port = deck.address().port
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${port}` } })
      return { status: response.status, data: await response.json() }
    }
  }
}

const constructorRequest = { tool_name: 'Bash', tool_input: { command: 'constructor' } }
const reasonIds = (h, id) => JSON.parse(h.deck.store.get('SELECT reasons FROM requests WHERE id = ?', id).reasons).map(item => item.entryId)
const allRequests = async h => {
  const out = []
  for (const state of ['open', 'answered', 'expired']) out.push(...(await h.request(`/api/requests?state=${state}`)).data.requests)
  return out
}

test('a constructor PermissionRequest is rated Caution, and a later request and Stop of the session still apply', async t => {
  const h = await harness(t)
  await h.start()
  const at = Date.now() - 10_000
  h.send('SessionStart', at)
  h.send('PermissionRequest', at + 1000, constructorRequest)
  h.send('PermissionRequest', at + 2000, { tool_name: 'Bash', tool_input: { command: 'pwd' } })
  h.send('Stop', at + 3000, { stop_hook_active: false })
  const requests = await allRequests(h)
  assert.deepEqual(requests.map(row => [row.createdAt - at, row.summary, row.tier]).sort((a, b) => a[0] - b[0]), [[1000, 'constructor', 'caution'], [2000, 'pwd', 'safe']])
  assert.ok(reasonIds(h, requests.find(row => row.summary === 'constructor').id).includes('unknown.command'))
  // The Stop applied too: it is the session's last activity.
  const sessions = (await h.request('/api/sessions')).data.sessions
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].lastActivityAt, at + 3000)
})

test('a constructor PermissionRequest spooled while the server is down is applied at the next start', async t => {
  const h = await harness(t)
  await h.start()
  const at = Date.now() - 10_000
  h.send('SessionStart', at)
  await h.stop()
  fs.mkdirSync(path.join(h.state, 'spool'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(h.state, 'spool', 'hooks-20261003-1790000000000-abcdefabcdef.jsonl'), `${h.envelope('PermissionRequest', at + 1000, constructorRequest)}\n`, { mode: 0o600 })
  await h.start()
  const requests = await allRequests(h)
  assert.deepEqual(requests.map(row => [row.createdAt - at, row.summary, row.tier, row.state]), [[1000, 'constructor', 'caution', 'open']])
  assert.ok(reasonIds(h, requests[0].id).includes('unknown.command'))
  assert.equal((await h.request('/api/sessions')).data.sessions[0].state, 'needs_approval')
})
