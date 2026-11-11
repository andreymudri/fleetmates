// fleet.mode, land.mode and land.autoMerge: the fleet-or-inline question and the landing choice
// become per-repository policy. autoMerge is the one key that lives only in the tracked manifest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/cli.mjs'
import { loadConfig } from '../scripts/config.mjs'

async function repo(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-land-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const lines = []
  const io = { out: (text) => lines.push(text), err: (text) => lines.push(text) }
  return { root, lines, io }
}

const get = async (ctx, key) => {
  ctx.lines.length = 0
  assert.equal(await runCli(['config', 'get', key, '--root', ctx.root], ctx.io), 0, ctx.lines.join('\n'))
  return ctx.lines.join('\n')
}

test('fleet.mode defaults to ask, land.mode to pr and land.autoMerge to false', async (t) => {
  const ctx = await repo(t)
  assert.equal(await get(ctx, 'fleet.mode'), 'ask')
  assert.equal(await get(ctx, 'land.mode'), 'pr')
  assert.equal(await get(ctx, 'land.autoMerge'), 'false')
})

test('config accepts the valid values in either layer and refuses the rest with exit 2', async (t) => {
  const ctx = await repo(t)
  const { root, io } = ctx
  assert.equal(await runCli(['config', 'set', 'fleet.mode', 'auto', '--root', root], io), 0)
  assert.equal(await runCli(['config', 'set', 'land.mode', 'ask', '--local', '--root', root], io), 0)
  assert.equal(await get(ctx, 'fleet.mode'), 'auto')
  assert.equal(await get(ctx, 'land.mode'), 'ask')
  for (const [key, value] of [['fleet.mode', 'yes'], ['land.mode', 'merge'], ['land.autoMerge', '"true"'], ['land.bogus', '1'], ['fleet.bogus', '1']]) {
    assert.equal(await runCli(['config', 'set', key, value, '--root', root], io), 2, `${key} ${value}`)
  }
})

test('land.autoMerge is accepted in the tracked manifest and refused in the local layer', async (t) => {
  const ctx = await repo(t)
  const { root, io, lines } = ctx
  lines.length = 0
  assert.equal(await runCli(['config', 'set', 'land.autoMerge', 'true', '--local', '--root', root], io), 2)
  assert.match(lines.join('\n'), /land\.autoMerge may only be set in fleetmates\.gate\.json/)
  assert.equal(await runCli(['config', 'set', 'land.autoMerge', 'true', '--root', root], io), 0)
  assert.equal(await get(ctx, 'land.autoMerge'), 'true')
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'fleetmates.gate.json'), 'utf8')), { land: { autoMerge: true } })
})

test('a hand-written local autoMerge is refused by every reader, so it can never switch merging on', async (t) => {
  const ctx = await repo(t)
  await writeFile(path.join(ctx.root, 'fleetmates.local.json'), JSON.stringify({ land: { autoMerge: true } }), 'utf8')
  await assert.rejects(loadConfig(ctx.root), /land\.autoMerge may only be set in fleetmates\.gate\.json/)
  assert.equal(await runCli(['config', 'get', 'land.autoMerge', '--root', ctx.root], ctx.io), 2)
})
