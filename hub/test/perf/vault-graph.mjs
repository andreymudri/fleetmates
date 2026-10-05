import { performance } from 'node:perf_hooks'
import { createVaultClient } from '../../server/adapters/vault-mcp.mjs'
import { makeVaultTree } from '../helpers/vault-tree.mjs'

const args = process.argv.slice(2)
let command, notes = 1000
try {
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--vault-mcp') command = JSON.parse(args[i + 1])
    else if (args[i] === '--notes') notes = Number(args[i + 1])
    else throw Error('unknown option')
  }
  if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part)) throw Error('missing argv')
} catch { process.stderr.write('usage: node hub/test/perf/vault-graph.mjs --vault-mcp \'["node","/path/to/server.js"]\' [--notes 1000]\n'); process.exit(2) }
const tree = await makeVaultTree({ kind: { notes } })
const client = createVaultClient({ command, env: { HOME: tree.root, VAULT_PATH: tree.root, VAULT_LANG: 'en', PATH: process.env.PATH } })
try {
  await client.start()
  if (!client.health().capabilities.includes('graph')) throw Error('vault-mcp has no graph capability; use version 0.4.0 or later')
  await client.call('vault_graph', { max_nodes: notes }, 10000)
  const timings = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    const result = await client.call('vault_graph', { max_nodes: notes }, 10000)
    if (result.isError || result.structured?.nodes.length !== notes) throw Error('graph did not return the generated notes')
    timings.push(performance.now() - start)
  }
  timings.sort((a, b) => a - b)
  process.stdout.write(`${JSON.stringify({ notes, samples: 5, p50Ms: timings[2], p95Ms: timings[4], version: client.health().version })}\n`)
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
finally { await client.close(); await tree.cleanup() }
