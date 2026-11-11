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

// merge-guard: auto-merge never lands a branch that edits the gate's own rules or the CI.
async function guardRepo(t, manifest) {
  const ctx = await repo(t)
  const g = (args) => execFileSync('git', args, { cwd: ctx.root })
  g(['config', 'user.email', 'test@example.com'])
  g(['config', 'user.name', 'Test'])
  g(['checkout', '--quiet', '-b', 'main'])
  if (manifest) await writeFile(path.join(ctx.root, 'fleetmates.gate.json'), JSON.stringify(manifest), 'utf8')
  await writeFile(path.join(ctx.root, 'app.js'), '1\n', 'utf8')
  g(['add', '.'])
  g(['commit', '--quiet', '-m', 'base'])
  g(['checkout', '--quiet', '-b', 'run'])
  const change = async (file, text = 'x\n') => {
    await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(path.join(ctx.root, file)), { recursive: true }))
    await writeFile(path.join(ctx.root, file), text, 'utf8')
    g(['add', '.'])
    g(['commit', '--quiet', '-m', `change ${file}`])
  }
  const guard = async () => {
    ctx.lines.length = 0
    return runCli(['merge-guard', '--branch', 'run', '--base', 'main', '--root', ctx.root], ctx.io)
  }
  return { ...ctx, change, guard }
}

test('merge-guard allows a branch that touches only ordinary files', async (t) => {
  const ctx = await guardRepo(t, { protected: ['skills/x.md'] })
  await ctx.change('app.js', '2\n')
  assert.equal(await ctx.guard(), 0, ctx.lines.join('\n'))
})

test('merge-guard refuses a branch that changes the gate manifest', async (t) => {
  const ctx = await guardRepo(t, { protected: [] })
  await ctx.change('fleetmates.gate.json', JSON.stringify({ land: { autoMerge: true } }))
  assert.equal(await ctx.guard(), 1)
  assert.match(ctx.lines.join('\n'), /auto-merge refused: run changes fleetmates\.gate\.json/)
})

test('merge-guard refuses a path from the base manifest\'s protected list, case folded', async (t) => {
  const ctx = await guardRepo(t, { protected: ['skills/x.md'] })
  await ctx.change('Skills/X.md')
  assert.equal(await ctx.guard(), 1, ctx.lines.join('\n'))
})

test('merge-guard refuses a branch that changes a CI workflow', async (t) => {
  const ctx = await guardRepo(t, null)
  await ctx.change('.github/workflows/test.yml', 'on: push\n')
  assert.equal(await ctx.guard(), 1)
  assert.match(ctx.lines.join('\n'), /\.github\/workflows\/test\.yml/)
})

test('merge-guard exits 2 on a missing branch', async (t) => {
  const ctx = await guardRepo(t, null)
  ctx.lines.length = 0
  assert.equal(await runCli(['merge-guard', '--branch', 'nope', '--base', 'main', '--root', ctx.root], ctx.io), 2)
  assert.equal(await runCli(['merge-guard', '--base', 'main', '--root', ctx.root], ctx.io), 2)
})
