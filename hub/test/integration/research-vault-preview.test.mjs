import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { memoryHarness } from '../helpers/memory-harness.mjs'
import { seedResearch, writeResearchDraft } from '../helpers/research.mjs'

// Exercise the published release against a disposable synthetic vault.
const realServer = process.env.RESEARCH_VAULT_MCP ?? createRequire(import.meta.url).resolve('@andreymudri/vault-mcp/dist/server/index.js')
test('research approves a real MCP preview and records exactly one synthetic vault commit', async t => {
  let vault
  const git = (...args) => execFileSync('git', ['-C', vault, ...args], { encoding: 'utf8' }).trim()
  const h = await memoryHarness(t, 'ok', { vaultCommand: [process.execPath, realServer], prepareVault: async root => {
    vault = root
    await fs.mkdir(path.join(root, '_templates'))
    await fs.writeFile(path.join(root, '_templates/wiki.md'), '# <% tp.file.title %>\n\n## Contexto\n')
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('config', 'commit.gpgsign', 'false'); git('config', 'gc.auto', '0'); git('add', '.'); git('commit', '-m', 'Initial fixture')
  } })
  const r = await seedResearch(h)
  await writeResearchDraft(r.repo, r.id)
  const request = (action, body) => h.request(`/api/research/${r.id}/${action}`, 'POST', body)
  // Adapter handshake is asynchronous. Detail exposes capability availability without writing.
  for (let n = 0; n < 100; n++) {
    if ((await h.request(`/api/research/${r.id}`)).data.research.save.canPreview) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const preview = await request('preview', { confirmNewDomain: true })
  assert.equal(preview.status, 200, JSON.stringify(preview.data))
  assert.equal(git('rev-list', '--count', 'HEAD'), '1')
  assert.equal(git('status', '--porcelain'), '')
  const plan = preview.data.research.save.preview
  const saved = await request('save', { previewId: plan.id })
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  assert.equal(saved.data.research.state, 'saved')
  assert.equal(git('rev-list', '--count', 'HEAD'), '2')
  assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), plan.files.map(file => file.path).sort())
  for (const file of plan.files) assert.equal(await fs.readFile(path.join(vault, file.path), 'utf8'), file.after)
  assert.equal((await request('save', { previewId: plan.id })).status, 409)
})
