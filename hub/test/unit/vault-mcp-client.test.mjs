// The deck's vault-mcp client (D-134) against the in-repo fake vault-mcp
// (test/fakes/fake-vault-mcp.mjs), started by absolute path with node itself. The child gets a
// minimal environment: a temporary HOME and XDG_RUNTIME_DIR, no session bus, display, SSH agent,
// deck or token variable. Timers are a manual queue, so backoff, ping and call timeouts are fired
// by the test instead of waited for.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createVaultClient, backoffMs } from '../../server/adapters/vault-mcp.mjs'
import { parseList, parseSearch, parseNote, parseBacklinks } from '../../server/adapters/vault-text.mjs'

const FAKE = fileURLToPath(new URL('../fakes/fake-vault-mcp.mjs', import.meta.url))
const COMMAND = [process.execPath, FAKE]

let tmp
test.before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'vault-client-')) })
test.after(async () => { await rm(tmp, { recursive: true, force: true }) })

/**
 * A minimal child environment built from nothing, so no host variable reaches the fake.
 * @param {Record<string, string>} extra
 * @returns {Record<string, string>}
 */
function childEnv (extra = {}) {
  return { HOME: tmp, XDG_RUNTIME_DIR: tmp, LANG: 'C.UTF-8', VAULT_PATH: '/home/you/vault', VAULT_LANG: 'en', ...extra }
}

/** A manual timer queue standing in for setTimeout and clearTimeout. */
function manualTimers () {
  let next = 1
  /** @type {Map<number, { ms: number, fn: () => void }>} */
  const queue = new Map()
  return {
    setTimeout (/** @type {() => void} */ fn, /** @type {number} */ ms) { const id = next++; queue.set(id, { ms, fn }); return id },
    clearTimeout (/** @type {number} */ id) { queue.delete(id) },
    /** @param {number} ms */
    pending (ms) { return [...queue.values()].filter(t => t.ms === ms).length },
    /** @returns {number[]} */
    delays () { return [...queue.values()].map(t => t.ms) },
    /** Fire every pending timer of this delay. @param {number} ms */
    fire (ms) {
      for (const [id, t] of [...queue]) if (t.ms === ms) { queue.delete(id); t.fn() }
    }
  }
}

/**
 * @param {Record<string, any>} [opts]
 */
function makeClient (opts = {}) {
  const timers = manualTimers()
  const states = []
  const clock = { t: 1_000_000 }
  const client = createVaultClient({
    command: COMMAND,
    env: childEnv(opts.env),
    timers,
    now: opts.now ?? (() => clock.t),
    log: () => {},
    ...opts.client
  })
  client.onHealth(h => states.push(h))
  return { client, timers, states, clock }
}

/**
 * Wait until the predicate over the client's health holds.
 * @param {{ health: () => any }} client
 * @param {(h: any) => boolean} pred
 */
async function until (client, pred, ms = 5000) {
  const end = Date.now() + ms
  while (!pred(client.health())) {
    if (Date.now() > end) throw new Error(`timed out waiting; health ${JSON.stringify(client.health())}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** @param {number} pid */
function alive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

test('start reaches ok with the server version and the graph and structured capabilities', async () => {
  const { client, states } = makeClient()
  try {
    const h = await client.start()
    assert.equal(h.state, 'ok')
    assert.equal(h.dep, 'vault-mcp')
    assert.equal(h.version, '0.4.0')
    assert.deepEqual(h.capabilities, ['graph', 'structured'])
    assert.equal(h.attempt, 0)
    assert.deepEqual(states.map(s => s.state), ['checking', 'ok'])
  } finally { await client.close() }
})

test('a 0.3.0 tool list gives no graph capability, even when the version string is newer', async () => {
  const { client } = makeClient({ env: { FAKE_VAULT_MODE: 'no-graph', FAKE_VAULT_VERSION: '0.4.0' } })
  try {
    const h = await client.start()
    assert.equal(h.state, 'ok')
    assert.deepEqual(h.capabilities, [])
  } finally { await client.close() }
})

test('a vault_graph listed by a server whose version reads 0.3.0 still gives graph', async () => {
  const { client } = makeClient({ env: { FAKE_VAULT_VERSION: '0.3.0' } })
  try {
    const h = await client.start()
    assert.ok(h.capabilities.includes('graph'))
  } finally { await client.close() }
})

test('a child that exits 1 is down with the stderr tail as reason and backs off 2 s, then 4 s', async () => {
  const { client, timers, clock } = makeClient({ env: { FAKE_VAULT_MODE: 'exit1' } })
  try {
    const h = await client.start()
    assert.equal(h.state, 'down')
    assert.equal(h.reason, 'spawn exited 1: VAULT_PATH is not a directory: /home/you/vault')
    assert.equal(h.attempt, 1)
    assert.equal(h.nextProbeAt, clock.t + 2000)
    assert.equal(timers.pending(2000), 1)
    await assert.rejects(client.call('vault_list', {}), { code: 'vault_unavailable' })

    timers.fire(2000)
    await until(client, s => s.state === 'down' && s.attempt === 2)
    assert.equal(client.health().nextProbeAt, clock.t + 4000)
    assert.equal(timers.pending(4000), 1)
    assert.equal(timers.pending(2000), 0)
  } finally { await client.close() }
})

test('backoff doubles from 2 s and stops at 60 s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 12].map(backoffMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
})

test('a vault_list call returns the text the list parser reads', async () => {
  const { client } = makeClient()
  try {
    await client.start()
    const r = await client.call('vault_list', {})
    assert.equal(r.isError, false)
    assert.equal(r.structured, null)
    const { notes, skipped } = parseList(r.text)
    assert.equal(skipped, 0)
    assert.equal(notes.length, 22)
    assert.ok(notes.some(n => n.path === '02-wiki/nestjs/bullmq-worker.md' && n.title === 'BullMQ worker'))
  } finally { await client.close() }
})

test('vault_graph passes its structuredContent through, and isError comes back without changing health', async () => {
  const { client } = makeClient()
  try {
    await client.start()
    const g = await client.call('vault_graph', {})
    assert.equal(g.structured.counts.notes, 22)
    assert.equal(g.structured.counts.edges, 34)
    assert.equal(g.structured.edges.length, 34)
    const missing = await client.call('vault_get_note', { path: '02-wiki/nope.md' })
    assert.equal(missing.isError, true)
    assert.equal(missing.text, 'note not found: 02-wiki/nope.md')
    assert.equal(client.health().state, 'ok')
  } finally { await client.close() }
})

test('the fake answers search, note and backlinks in text the parsers read', async () => {
  const { client } = makeClient()
  try {
    await client.start()
    const s = parseSearch((await client.call('vault_search', { query: 'retry backoff' })).text)
    assert.equal(s.skipped, 0)
    const cited = s.hits.find(h => h.path === '02-wiki/nestjs/bullmq-worker.md')
    assert.equal(cited.line, 13)
    assert.equal(cited.trail, 'Retry e backoff')
    assert.equal(cited.viaGraph, false)
    const graph = s.hits.find(h => h.path === '02-wiki/nestjs/auth-guard.md')
    assert.equal(graph.line, 11)
    assert.equal(graph.viaGraph, true)

    const n = parseNote((await client.call('vault_get_note', { path: '02-wiki/nestjs/bullmq-worker.md' })).text)
    assert.equal(n.title, 'BullMQ worker')
    assert.equal(n.frontmatter.tags, 'nestjs, filas')
    assert.deepEqual(n.links, ['02-wiki/nestjs/auth-guard.md', '02-wiki/patterns/retry-backoff.md'])
    assert.equal(n.body.split('\n')[13 - 10], '## Retry e backoff')

    const b = parseBacklinks((await client.call('vault_backlinks', { path: '02-wiki/nestjs/bullmq-worker.md' })).text)
    assert.equal(b.notes.length, 3)
  } finally { await client.close() }
})

test('the fake refuses a write tool with isError and logs it without the arguments', async () => {
  const log = path.join(tmp, 'write.log')
  const { client } = makeClient({ env: { FAKE_VAULT_LOG: log } })
  try {
    await client.start()
    const r = await client.call('vault_learn', { titulo: 'segredo-sentinela' })
    assert.equal(r.isError, true)
    const text = await readFile(log, 'utf8')
    assert.ok(text.split('\n').includes('write:vault_learn'))
    assert.ok(!text.includes('segredo-sentinela'))
  } finally { await client.close() }
})

test('slow answers twice give degraded and fast probes twice give ok again; the 30 s timer pings', async () => {
  const log = path.join(tmp, 'slow.log')
  const { client, timers } = makeClient({
    env: { FAKE_VAULT_MODE: 'slow', FAKE_VAULT_DELAY_MS: '300', FAKE_VAULT_LOG: log },
    now: Date.now,
    client: { slowMs: 150 }
  })
  try {
    await client.start()
    await client.call('vault_list', {})
    assert.equal(client.health().state, 'ok')
    await client.call('vault_list', {})
    assert.equal(client.health().state, 'degraded')

    assert.equal(timers.pending(30000), 1)
    timers.fire(30000)
    await until(client, () => timers.pending(30000) === 1)
    assert.equal(client.health().state, 'degraded')
    await client.probe()
    assert.equal(client.health().state, 'ok')
    const lines = (await readFile(log, 'utf8')).trim().split('\n')
    assert.deepEqual(lines.filter(l => l === 'ping').length, 2)
  } finally { await client.close() }
})

test('a call that never answers times out as vault_timeout and marks the health checking', async () => {
  const { client, timers, states } = makeClient({ env: { FAKE_VAULT_MODE: 'hang' } })
  try {
    await client.start()
    const p = client.call('vault_list', {}, { timeoutMs: 1234 })
    assert.equal(timers.pending(1234), 1)
    timers.fire(1234)
    await assert.rejects(p, { code: 'vault_timeout' })
    assert.ok(states.some(s => s.state === 'checking' && states.indexOf(s) > 1))
    await until(client, s => s.state === 'ok')
  } finally { await client.close() }
})

test('retry() restarts at once and rejects the call in flight with vault-mcp restarted', async () => {
  const { client } = makeClient({ env: { FAKE_VAULT_MODE: 'hang' } })
  try {
    await client.start()
    const first = client.pid()
    const rejected = assert.rejects(client.call('vault_list', {}), { code: 'vault_unavailable', message: 'vault-mcp restarted' })
    const h = await client.retry()
    await rejected
    assert.equal(h.state, 'ok')
    assert.notEqual(client.pid(), first)
    await until(client, () => !alive(first))
  } finally { await client.close() }
})

test('a line over 16 MiB kills the child as protocol_error', async () => {
  const { client } = makeClient({ env: { FAKE_VAULT_MODE: 'huge' } })
  try {
    await client.start()
    const pid = client.pid()
    await assert.rejects(client.call('vault_list', {}), { code: 'protocol_error' })
    assert.equal(client.health().state, 'down')
    assert.match(client.health().reason, /^protocol_error: /)
    await until(client, () => !alive(pid))
  } finally { await client.close() }
})

test('a protocol version outside the three accepted is refused', async () => {
  const { client } = makeClient({ env: { FAKE_VAULT_PROTOCOL: '2099-01-01' } })
  try {
    const h = await client.start()
    assert.equal(h.state, 'down')
    assert.equal(h.reason, 'unsupported protocol version: 2099-01-01')
  } finally { await client.close() }
})

test('each accepted protocol version is taken', async () => {
  for (const v of ['2025-03-26', '2024-11-05']) {
    const { client } = makeClient({ env: { FAKE_VAULT_PROTOCOL: v } })
    try {
      assert.equal((await client.start()).state, 'ok')
    } finally { await client.close() }
  }
})

test('close() leaves no child and no timer', async () => {
  const { client, timers } = makeClient()
  await client.start()
  const pid = client.pid()
  assert.ok(alive(pid))
  const closed = await Promise.race([
    client.close().then(() => 'closed'),
    new Promise(resolve => setTimeout(resolve, 3000, 'close() did not settle'))
  ])
  try {
    assert.equal(closed, 'closed')
    assert.equal(alive(pid), false)
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
  assert.deepEqual(timers.delays(), [])
  assert.equal(client.pid(), null)
})
