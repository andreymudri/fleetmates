import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVaultClient } from '../../server/adapters/vault-mcp.mjs'
import { parseList, parseNote, parseBacklinks, parseSearch } from '../../server/adapters/vault-text.mjs'
import { makeVaultTree } from '../helpers/vault-tree.mjs'

const require = createRequire(import.meta.url)
const realServer = require.resolve('@andreymudri/vault-mcp/dist/server/index.js')
const fakeServer = fileURLToPath(new URL('../fakes/fake-vault-mcp.mjs', import.meta.url))
const snapshot = new URL('../fixtures/vault-mcp/0.5.0/tools-list.json', import.meta.url)
const worker = '02-wiki/nestjs/bullmq-worker.md'

function sortedGraph (graph) {
  return {
    ...graph,
    nodes: graph.nodes.map(node => ({ ...node, tags: [...node.tags].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`)),
    ...(graph.broken ? { broken: [...graph.broken].sort((a, b) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`)) } : {})
  }
}

async function withClients (fn) {
  const tree = await makeVaultTree({ kind: 'vault22' })
  const tools = []
  const env = { HOME: tree.root, XDG_RUNTIME_DIR: tree.root, VAULT_PATH: tree.root, VAULT_LANG: 'en' }
  // This file pins schemas and parsers, not latency: a slowMs no cold start reaches keeps both clients ok.
  const slowMs = 600_000
  const real = createVaultClient({ command: [process.execPath, realServer], env, slowMs, spawn: (...args) => {
    const child = spawn(...args)
    let pending = ''
    child.stdout.on('data', chunk => {
      pending += chunk
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        const message = JSON.parse(line)
        if (message.result?.tools) tools.push(...message.result.tools)
      }
    })
    return child
  } })
  const fake = createVaultClient({ command: [process.execPath, fakeServer], env, slowMs })
  let realPid, fakePid
  try {
    assert.equal((await real.start()).state, 'ok')
    assert.equal((await fake.start()).state, 'ok')
    realPid = real.pid()
    fakePid = fake.pid()
    await fn({ real, fake, tools, tree })
  } finally {
    await Promise.all([real.close(), fake.close()])
    for (const pid of [realPid, fakePid].filter(Boolean)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await tree.cleanup()
  }
}

test('vault-mcp 0.5.0 publishes the pinned ten-tool input and graph output schemas', async () => {
  await withClients(async ({ real, tools }) => {
    assert.equal(real.health().version, '0.5.0')
    assert.deepEqual(real.health().capabilities, ['graph', 'structured', 'preview'])
    const actual = tools.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, ...(outputSchema ? { outputSchema } : {}) })).sort((a, b) => a.name.localeCompare(b.name))
    assert.equal(actual.length, 10)
    assert.ok(actual.find(tool => tool.name === 'vault_graph').outputSchema)
    const learn = actual.find(tool => tool.name === 'vault_learn').inputSchema.properties
    for (const key of ['preview', 'preview_time', 'expected_revision', 'force_new']) assert.ok(learn[key], `published learn schema must expose ${key}`)
    if (process.env.UPDATE_SNAPSHOT === '1') {
      await mkdir(new URL('.', snapshot), { recursive: true })
      await writeFile(snapshot, JSON.stringify(actual, null, 2) + '\n')
    }
    assert.deepEqual(actual, JSON.parse(await readFile(snapshot, 'utf8')))
  })
})

test('the deck parsers read real vault list, note, backlinks, search and missing-note answers', async () => {
  await withClients(async ({ real }) => {
    const list = parseList((await real.call('vault_list')).text)
    assert.equal(list.notes.length, 22)
    assert.equal(list.skipped, 0)
    const ref = list.notes.find(note => note.path === worker)
    assert.equal(ref.title, 'BullMQ worker')
    assert.deepEqual(ref.tags, ['nestjs', 'filas'])
    const note = parseNote((await real.call('vault_get_note', { path: worker })).text)
    assert.equal(note.path, worker)
    assert.equal(note.frontmatter.tipo, 'wiki')
    assert.ok(note.links.length > 0)
    assert.match(note.body, /Retry e backoff/)
    assert.equal(parseBacklinks((await real.call('vault_backlinks', { path: worker })).text).notes.length, 3)
    const hits = parseSearch((await real.call('vault_search', { query: 'retry backoff', limit: 20 })).text).hits
    assert.ok(hits.some(hit => hit.path === worker && hit.line > 0))
    assert.ok(hits.some(hit => hit.viaGraph))
    const missing = await real.call('vault_get_note', { path: '02-wiki/missing.md' })
    assert.equal(missing.isError, true)
    assert.match(missing.text, /note not found:/i)
  })
})

test('the real and fake vault22 graph agree on nodes, edges, counts and broken links', async () => {
  await withClients(async ({ real, fake, tree }) => {
    const actual = (await real.call('vault_graph', { include_broken: true })).structured
    const expected = (await fake.call('vault_graph', { include_broken: true })).structured
    // The fake's today mtime is computed at process start. The tree preserves its own generation time.
    for (const node of expected.nodes) node.mtime_ms = (await stat(path.join(tree.root, node.id))).mtimeMs
    assert.deepEqual(sortedGraph(actual), sortedGraph(expected))
    assert.equal(actual.nodes.length, 22)
    assert.equal(actual.edges.length, 34)
  })
})

test('a real vault graph reports no area or domain for a root note', async () => {
  await withClients(async ({ real, tree }) => {
    await writeFile(path.join(tree.root, 'root.md'), '# Root note\n')
    const graph = (await real.call('vault_graph')).structured
    const root = graph.nodes.find(node => node.id === 'root.md')
    assert.equal(root.area, '')
    assert.equal(root.domain, null)
  })
})

test('the generated vault has exactly N deterministic notes over eight domains and no Git metadata', async () => {
  const trees = await Promise.all([makeVaultTree({ kind: { notes: 40 } }), makeVaultTree({ kind: { notes: 40 } })])
  try {
    const walk = async dir => {
      const entries = await readdir(dir, { withFileTypes: true })
      return (await Promise.all(entries.map(async entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat()
    }
    const files = await walk(trees[0].root)
    assert.equal(files.length, 40)
    assert.equal(new Set(files.filter(file => file.includes('02-wiki')).map(file => path.relative(trees[0].root, file).split(/[\\/]/)[1])).size, 8)
    assert.ok(!files.some(file => file.includes('.git')))
    for (const file of files) {
      const relative = path.relative(trees[0].root, file)
      assert.equal(await readFile(file, 'utf8'), await readFile(path.join(trees[1].root, relative), 'utf8'))
      assert.equal((await readFile(file, 'utf8')).match(/\[\[/g).length, 5)
    }
  } finally { await Promise.all(trees.map(tree => tree.cleanup())) }
})
