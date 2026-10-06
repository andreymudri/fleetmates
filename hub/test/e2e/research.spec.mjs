import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright-core'
import { memoryHarness, token } from '../helpers/memory-harness.mjs'
import { seedResearch, writeResearchDraft } from '../helpers/research.mjs'
const hub = fileURLToPath(new URL('../..', import.meta.url))
let browser
before(async () => {
  await build({ configFile: `${hub}/web/vite.config.mjs`, logLevel: 'silent' })
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true })
})
after(async () => browser?.close())
async function pageFor (t, options = {}) {
  const h = await memoryHarness(t, 'ok', { web: `${hub}/web/dist`, ...options })
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  return { h, page }
}
async function axe (page) {
  const source = await fs.readFile(path.join(hub, 'node_modules/axe-core/axe.min.js'), 'utf8')
  await page.evaluate(source)
  const failures = await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })))
  assert.deepEqual(failures, [])
}

test('research form launches a fake team session, review restores validated sources and Save is blocked', async t => {
  const { h, page } = await pageFor(t, { pty: true })
  const repo = path.join(h.home, 'synthetic-repo')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  await fs.writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n')
  h.deck.store.run('INSERT INTO repos(id,name,crew_seed,crew_slot,first_seen_at) VALUES(?,?,?,?,?)', repo, 'synthetic-repo', 'synthetic-repo', 0, 1)
  await page.goto(`${h.base}/research/new?topic=Session%20lock%20lifetime#token=${token}`)
  const topic = page.getByRole('textbox', { name: 'Topic', exact: true })
  await topic.waitFor()
  assert.equal(await topic.inputValue(), 'Session lock lifetime')
  await page.getByLabel('Target domain').fill('concurrency')
  await axe(page)
  await page.getByRole('button', { name: 'Send scouts', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Scouting' }).waitFor()
  const id = page.url().split('/research/')[1].split(/[?#]/)[0]
  assert.match(id, /^research-/)
  const row = h.deck.store.get('SELECT * FROM research WHERE id=?', id)
  assert.equal(h.deck.store.get('SELECT task FROM sessions WHERE id=?', row.lead_session_id).task, 'Session lock lifetime')
  await writeResearchDraft(repo, id)
  await page.getByRole('button', { name: 'Refresh research' }).click()
  await page.getByRole('status').filter({ hasText: 'Draft · not saved' }).waitFor()
  await page.getByRole('heading', { name: 'Session locks', exact: true }).waitFor()
  assert.ok(await page.getByRole('button', { name: 'Save to vault' }).isDisabled())
  assert.equal((await h.request(`/api/research/${id}/save`, 'POST')).data.error.code, 'preview_required')
  await page.reload()
  await page.getByRole('heading', { name: 'Rejected sources' }).waitFor()
  assert.ok((await page.getByRole('region', { name: 'Research review' }).textContent()).includes('Outdated'))
  await axe(page)
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  assert.equal(storage.includes('Session lock lifetime'), false)
  h.deck.store.run("INSERT INTO prefs(key,value,updated_at) VALUES('firstRunCompletedAt','1',1)")
  await page.goto(`${h.base}/`)
  await page.getByRole('link', { name: 'Review draft', exact: true }).waitFor()
})

test('research palette opens the shared form and hostile draft text cannot execute markup', async t => {
  const { h, page } = await pageFor(t)
  const r = await seedResearch(h)
  const hostile = '<script>globalThis.researchInjected=1</script>\n[bad](javascript:alert(1))\nSafe. [1]\n\n## Sources\n1. Source'
  await writeResearchDraft(r.repo, r.id, { body: hostile })
  await page.goto(`${h.base}/research/${r.id}#token=${token}`)
  await page.getByRole('heading', { name: 'Session locks' }).waitFor()
  assert.equal(await page.locator('.research-body script').count(), 0)
  assert.equal(await page.locator('.research-body a[href^="javascript:"]').count(), 0)
  assert.equal(await page.evaluate(() => globalThis.researchInjected), undefined)
  await page.keyboard.press('Alt+k')
  await page.getByRole('combobox').fill('> research retry backoff')
  await page.getByRole('combobox').press('Enter')
  await page.getByRole('textbox', { name: 'Topic', exact: true }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Topic', exact: true }).inputValue(), 'retry backoff')
  const related = page.getByRole('group', { name: 'Existing notes to link' }).getByRole('checkbox').first()
  await related.click()
  assert.equal(await related.isChecked(), true)
})


const realServer = process.env.RESEARCH_VAULT_MCP ?? createRequire(import.meta.url).resolve('@andreymudri/vault-mcp/dist/server/index.js')

test('research owner edits citations, previews and saves through the published MCP', async t => {
  let vault
  const git = (...args) => execFileSync('git', ['-C', vault, ...args], { encoding: 'utf8' }).trim()
  const { h, page } = await pageFor(t, { vaultCommand: [process.execPath, realServer], prepareVault: async root => {
    vault = root
    await fs.mkdir(path.join(root, '_templates'))
    await fs.writeFile(path.join(root, '_templates/wiki.md'), '# <% tp.file.title %>\n\n## Contexto\n')
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('config', 'commit.gpgsign', 'false'); git('config', 'gc.auto', '0'); git('add', '.'); git('commit', '-m', 'Initial fixture')
  } })
  const r = await seedResearch(h)
  await writeResearchDraft(r.repo, r.id)
  await page.goto(`${h.base}/research/${r.id}#token=${token}`)
  await page.getByRole('heading', { name: 'Session locks', exact: true }).waitFor()
  await page.getByRole('checkbox', { name: 'Keep source 1' }).click()
  await page.locator('mark.research-orphan').waitFor()
  assert.ok(await page.getByRole('button', { name: 'Prepare preview' }).isDisabled())
  await page.getByRole('checkbox', { name: 'Keep source 1' }).click()
  await page.waitForFunction(() => !document.querySelector('mark.research-orphan'))
  await page.getByRole('button', { name: 'Edit first', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Draft markdown' })
  await editor.fill((await editor.inputValue()) + '\nOwner approved evidence.')
  await page.getByRole('button', { name: 'Done editing' }).click()
  await page.getByRole('button', { name: 'Edit first', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Prepare preview' }).click()
  await page.getByRole('button', { name: 'Confirm new domain' }).click()
  await page.getByRole('region', { name: 'Save preview' }).waitFor()
  assert.equal(git('rev-list', '--count', 'HEAD'), '1')
  await axe(page)
  await page.getByRole('button', { name: 'Save to vault', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Saved to vault' }).waitFor()
  assert.equal(git('rev-list', '--count', 'HEAD'), '2')
  await page.reload()
  await page.getByRole('status').filter({ hasText: 'Saved to vault' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Edit first', exact: true }).count(), 0)
  await axe(page)
})
